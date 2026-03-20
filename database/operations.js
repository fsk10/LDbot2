const { EmbedBuilder } = require('discord.js');
const { EventModel, UserModel, SettingsModel, EventUsersModel, TemporaryRegistration } = require('../models/index.js');
const { Op } = require('sequelize');
const { sequelize } = require('../database/database');
const settingsConfig = require('../config/settingsConfig');
const defaultSettings = Object.keys(settingsConfig);
const logger = require('../utils/logger');
const fs = require('fs').promises;
const path = require('path');
const config = require('../config/charts.config.json');
const { loadChartById, renderMapForEvent } = require('../utils/seating');

// Used in the function "scheduleParticipantListUpdate"
let updateScheduled = false;

/* -------------------- Helpers -------------------- */

// Creates a new event in the database.
async function addEvent(eventData) {
  try {
    await EventModel.create(eventData);
    return { success: true };
  } catch (error) {
    logger.error(`Error creating event "${eventData?.name}" in database:`, error);
    return { success: false, error: error.message };
  }
}

// Coerce any input to an integer seat, or null if not valid
function toSeatInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/* -------------------- Event <-> User (add) -------------------- */

// Adds a user to an event in the database.
async function addUser(userData, client) {
  try {
    // Check if the User Exists (by discorduser)
    let user = await UserModel.findOne({ where: { discorduser: userData.discorduser } });

    // If user doesn't exist, create one
    if (!user) {
      user = await UserModel.create({
        discorduser: userData.discorduser,
        nickname: userData.nickname,
        firstname: userData.firstname,
        lastname: userData.lastname,
        country: userData.country,
        email: userData.email
      });
    }

    const event = await EventModel.findByPk(userData.event);
    if (!event) {
      return { success: false, error: 'Event not found.' };
    }

    // Decide reserve if not provided by caller, based on capacity
    const occupiedSeats = await EventUsersModel.count({ where: { eventId: userData.event, reserve: false } });
    if (typeof userData.reserve === 'undefined') {
      const capacity = Number(event?.seatsavailable || 0);
      userData.reserve = occupiedSeats >= capacity;
    }

    // Work out seat intent
    // - If reserve explicitly true -> seat must be null
    // - Else if a seat is explicitly provided -> use it (int)
    // - Else do not touch seat on update
    const seatProvided = Object.prototype.hasOwnProperty.call(userData, 'seat');
    const reserveProvided = Object.prototype.hasOwnProperty.call(userData, 'reserve');

    let requestedSeat;
    if (userData.reserve === true) {
      requestedSeat = null;
    } else if (seatProvided) {
      requestedSeat = toSeatInt(userData.seat);
    } else {
      requestedSeat = undefined; // no change if updating existing row
    }

    // If assigning a concrete seat (non-reserve), ensure it's not taken
    if (userData.reserve === false && typeof requestedSeat === 'number') {
      const isSeatTaken = await EventUsersModel.findOne({
        where: { eventId: userData.event, seat: requestedSeat }
      });
      if (isSeatTaken) {
        return { success: false, error: 'The specified seat is already taken for this event. Please choose a different seat.' };
      }
    }

    // Add or Update Association in EventUsers Table
    let eventUserAssociation = await EventUsersModel.findOne({
      where: {
        userId: user.id,
        eventId: userData.event
      }
    });

    if (eventUserAssociation) {
      // Update only fields explicitly provided:
      if (reserveProvided) {
        eventUserAssociation.reserve = !!userData.reserve;
        if (userData.reserve === true) {
          eventUserAssociation.seat = null; // force seat null when moving to reserve
        }
      }
      if (requestedSeat !== undefined) {
        eventUserAssociation.seat = requestedSeat;
      }
      if (Object.prototype.hasOwnProperty.call(userData, 'haspaid')) {
        eventUserAssociation.haspaid = !!userData.haspaid;
        eventUserAssociation.paidAt = userData.haspaid ? new Date() : null;
      }
      await eventUserAssociation.save();
    } else {
      // Create a new association (haspaid only if supplied; paidAt accordingly)
      eventUserAssociation = await EventUsersModel.create({
        userId: user.id,
        eventId: userData.event,
        seat: requestedSeat ?? null,
        haspaid: !!userData.haspaid,
        paidAt: userData.haspaid ? new Date() : null,
        reserve: !!userData.reserve,
        status: 'confirmed'
      });
    }

    // Only schedule a participant list update if haspaid was true (legacy behavior kept)
    if (userData.haspaid) {
      await scheduleParticipantListUpdate(client, userData.event);
    }

    return { success: true, user };
  } catch (error) {
    if (error.name === 'SequelizeUniqueConstraintError') {
      throw new Error('A user with this email already exists.');
    } else {
      logger.error(`Error adding user "${userData?.discorduser}" to database:`, error);
      return { success: false, error: error.message || 'Validation error' };
    }
  }
}

/* -------------------- Update event / user / eventuser -------------------- */

async function updateEvent(eventId, updatedFields) {
  try {
    // Extract only the numeric ID from the channel mention format
    const channelMention = updatedFields.participantchannel;
    if (channelMention) {
      const channelId = channelMention.match(/\d+/)?.[0];
      if (channelId) updatedFields.participantchannel = channelId;
    }

    const result = await EventModel.update(updatedFields, { where: { id: eventId } });

    if (result[0] > 0) {
      return { success: true };
    } else {
      return { success: false, message: 'Event not found or no fields updated.' };
    }
  } catch (error) {
    logger.error('Error updating event:', error);
    return { success: false, error: error.message };
  }
}

async function updateUser(nickname, updatedFields, client) {
  try {
    const user = await UserModel.findOne({ where: { nickname } });
    if (!user) {
      logger.error(`User with nickname "${nickname}" not found.`);
      return { success: false, message: `User "${nickname}" not found.` };
    }

    const result = await UserModel.update(updatedFields, { where: { id: user.id } });

    if (result[0] > 0) {
      // If the nickname was changed, update the participant list for all events the user is part of
      if ('nickname' in updatedFields) {
        const userEvents = await EventUsersModel.findAll({ where: { userId: user.id } });
        for (const userEvent of userEvents) {
          await updateParticipantList(client, userEvent.eventId);
        }
      }

      return { success: true };
    } else {
      logger.error(`No fields were updated for user: ${nickname}`);
      return { success: false, message: 'No fields updated.' };
    }
  } catch (error) {
    logger.error(`Error updating user with nickname ${nickname}: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Update event-data for a user
async function updateEventUser(eventId, userId, updatedFields, client) {
  try {
    // Normalize seat to integer/null if provided
    if ('seat' in updatedFields) {
      updatedFields.seat = toSeatInt(updatedFields.seat);
    }

    // Handle paidAt consistently:
    //  - if explicitly setting haspaid true -> set paidAt now
    //  - if explicitly setting haspaid false -> clear paidAt
    if ('haspaid' in updatedFields) {
      updatedFields.paidAt = updatedFields.haspaid ? new Date() : null;
    }

    const [affected] = await EventUsersModel.update(updatedFields, {
      where: { eventId, userId }
    });

    if (affected > 0) {
      // Any change to seat/haspaid/reserve should refresh the participant channel.
      // Use the debounced updater to coalesce rapid edits into one render.
      scheduleParticipantListUpdate(client, eventId);
      return { success: true };
    }
    return { success: false, message: 'Event-user relation not found or no fields updated.' };
  } catch (error) {
    logger.error(`Error updating event-user relation with eventId: ${eventId}, userId: ${userId}: ${error.message}`);
    return { success: false, error: error.message };
  }
}


/* -------------------- Deletes -------------------- */

async function deleteEvent(eventId) {
  const t = await sequelize.transaction();
  try {
    // Load the event inside the transaction
    const event = await EventModel.findOne({ where: { id: eventId }, transaction: t });
    if (!event) {
      await t.rollback();
      return { success: false, error: `Event with ID "${eventId}" does not exist.` };
    }
    const eventName = event.name;

    // 1) Clean up any in-progress registrations (best-effort)
    try {
      await TemporaryRegistration.destroy({ where: { eventId }, transaction: t });
    } catch (e) {
      logger.warn('Could not clean up TemporaryRegistration during event delete (may not exist):', e.message);
    }

    // 2) Delete join-table rows referencing the event
    await EventUsersModel.destroy({ where: { eventId }, transaction: t });

    // 3) Delete the event itself
    await EventModel.destroy({ where: { id: eventId }, transaction: t });

    await t.commit();
    return { success: true, eventName };
  } catch (err) {
    await t.rollback();
    logger.error('[deleteEvent] failed:', err);
    return { success: false, error: `Failed to delete event: ${err.message}` };
  }
}

async function deleteUserFromEvent(nickname, eventName, client) {
  const user = await UserModel.findOne({ where: { nickname } });
  const event = await EventModel.findByPk(eventName);

  if (!user) {
    return { success: false, error: `User "${nickname}" does not exist.` };
  }
  if (!event) {
    return { success: false, error: `Event "${eventName}" does not exist.` };
  }

  const result = await EventUsersModel.destroy({ where: { userId: user.id, eventId: event.id } });
  if (result === 0) {
    return { success: false, error: `User "${nickname}" is not associated with the event "${eventName}".` };
  }

  await updateParticipantList(client, event.id);
  return { success: true, eventName: event.name };
}

async function deleteUserCompletely(nickname, client) {
  try {
    const user = await UserModel.findOne({
      where: { nickname },
      include: { model: EventModel, as: 'events' }
    });

    if (!user) {
      return { success: false, message: `User with nickname "${nickname}" not found.` };
    }

    await EventUsersModel.destroy({ where: { userId: user.id } });

    for (const event of user.events) {
      await updateParticipantList(client, event.id);
    }

    await UserModel.destroy({ where: { id: user.id } });

    return { success: true };
  } catch (error) {
    logger.error(`Error deleting user "${nickname}":`, error);
    return { success: false, error: error.message };
  }
}

/* -------------------- Misc associations & moves -------------------- */

async function associateUserToEvent(userId, eventId) {
  try {
    await EventUsersModel.create({ userId, eventId });
    return { success: true };
  } catch (error) {
    logger.error(`Error associating userId ${userId} to eventId ${eventId}:`, error);
    return { success: false, error: error.message || 'Validation error' };
  }
}

async function moveUserFromReserve(userId, eventId) {
  try {
    const row = await EventUsersModel.findOne({ where: { userId, eventId } });
    if (!row) return { success: false, error: "User not found in the event" };
    if (!row.reserve) return { success: false, error: "User is not in the reserve list" };

    // Get the first available seat among main list
    const occupiedSeats = (await EventUsersModel.findAll({
      where: { eventId, reserve: false, seat: { [Op.ne]: null } },
      attributes: ['seat'],
      order: [['seat', 'ASC']]
    })).map(s => s.seat);

    let seatToAssign = 1;
    for (const taken of occupiedSeats) {
      if (taken === seatToAssign) seatToAssign++;
      else break;
    }

    row.seat = seatToAssign;
    row.reserve = false;
    await row.save();

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/* -------------------- Settings -------------------- */

async function getSetting(key) {
  try {
    const setting = await SettingsModel.findOne({ where: { key } });
    if (setting) {
      return { success: true, value: setting.value };
    } else {
      logger.error(`Setting with key ${key} not found in the database`);
      return { success: false, message: "Setting not found." };
    }
  } catch (error) {
    logger.error("Error fetching setting:", error);
    return { success: false, message: error.message };
  }
}

async function setSetting(key, value) {
  if (!defaultSettings.includes(key)) {
    logger.error(`Attempted to set an unrecognized setting: ${key}`);
    return { success: false, message: "Unrecognized setting." };
  }

  try {
    const setting = await SettingsModel.findOne({ where: { key } });

    if (setting) {
      setting.value = value;
      await setting.save();
      return { success: true, message: "Setting updated successfully." };
    } else {
      return { success: false, message: "Setting does not exist." };
    }
  } catch (error) {
    logger.error("Error setting value:", error);
    return { success: false, message: error.message };
  }
}

/* -------------------- Lists / Queries -------------------- */

async function listUsers(eventId) {
  if (eventId) {
    return await UserModel.findAll({
      include: [{
        model: EventModel,
        as: 'events',
        where: { id: eventId },
        required: true
      }]
    });
  } else {
    return UserModel.findAll({
      include: { model: EventModel, as: 'events' }
    });
  }
}

async function listEventsForUser(discordUserId) {
  try {
    const userWithEvents = await UserModel.findOne({
      where: { discorduser: discordUserId },
      include: [{ model: EventModel, as: 'events' }]
    });

    if (!userWithEvents) {
      logger.error(`User not found with ID: ${discordUserId}`);
      return [];
    }

    if (!userWithEvents.events || userWithEvents.events.length === 0) {
      logger.error(`No events found for the user with ID: ${discordUserId}`);
      return [];
    }

    return userWithEvents.events;
  } catch (error) {
    logger.error('Error listing events for user:', error);
    return [];
  }
}

async function listEvents(options = {}) {
  const { all = false, archived = false } = options;

  if (all) {
    return await EventModel.findAll();
  } else if (archived) {
    return await EventModel.findAll({
      where: { enddate: { [Op.lt]: new Date() } }
    });
  } else {
    return await EventModel.findAll({
      where: { enddate: { [Op.gte]: new Date() } }
    });
  }
}

async function getEvent(eventID) {
  try {
    const event = await EventModel.findOne({ where: { id: eventID } });
    return event;
  } catch (error) {
    logger.error('Error fetching event:', error);
    return null;
  }
}

async function checkSeatTaken(eventID, seatNumber) {
  try {
    const seat = toSeatInt(seatNumber);
    if (seat === null) return false;
    const seatTaken = await EventUsersModel.findOne({ where: { eventId: eventID, seat } });
    return !!seatTaken;
  } catch (error) {
    logger.error('Error checking seat:', error);
    return false;
  }
}

// FIXED: resolve by discorduser → then check EventUsers with numeric user.id
async function checkUserInEvent(discordUserId, eventId) {
  try {
    const user = await UserModel.findOne({ where: { discorduser: discordUserId } });
    if (!user) return false;

    const association = await EventUsersModel.findOne({
      where: { userId: user.id, eventId }
    });
    return !!association;
  } catch (error) {
    logger.error('Error checking user in event:', error);
    return false;
  }
}

/* -------------------- Registration flow helpers -------------------- */

async function assignSeat(userId, eventId, preferredSeats) {
  if (!preferredSeats || preferredSeats.length === 0) {
    logger.info("No preferred seats provided.");
    return null;
  }

  const tempUserDetails = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
  if (!tempUserDetails) {
    logger.error(`Error fetching temporary registration details for user ${userId}`);
    return null;
  }

  const [user] = await UserModel.findOrCreate({
    where: { discorduser: userId },
    defaults: {
      discorduser: userId,
      nickname: tempUserDetails.nickname,
      firstname: tempUserDetails.firstname,
      lastname: tempUserDetails.lastname,
      email: tempUserDetails.email,
      country: tempUserDetails.country
    }
  });

  if (!user) {
    logger.error(`Error creating or fetching user for discorduser ${userId}`);
    return null;
  }

  const currentSeatRecord = await EventUsersModel.findOne({
    where: { userId: user.id, eventId }
  });
  const currentSeat = currentSeatRecord ? currentSeatRecord.seat : null;

  const eventRow = await EventModel.findByPk(eventId);
  let validSet = new Set();

  if (eventRow?.chartId) {
    try {
      const { chart } = await loadChartById(eventRow.chartId);
      validSet = new Set(chart.seats.map(s => String(s.id)));
    } catch {
      logger.warn('Seat chart not found/invalid for event; falling back to legacy behavior.');
    }
  }

  for (let i = 0; i < preferredSeats.length; i++) {
    const seat = String(preferredSeats[i]);
    if (seat == null) continue;

    if (validSet.size && !validSet.has(String(seat))) {
      continue;
    }

    const seatTaken = await EventUsersModel.findOne({ where: { eventId, seat: toSeatInt(seat) } });
    const seatAsInt = toSeatInt(seat);

    if (!seatTaken || seatAsInt === currentSeat) {
      const userEventRecord = await EventUsersModel.findOne({
        where: { userId: user.id, eventId }
      });

      if (userEventRecord) {
        userEventRecord.seat = seatAsInt;
        await userEventRecord.save();
        return seatAsInt;
      } else {
        try {
          await EventUsersModel.create({
            userId: user.id,
            eventId,
            seat: seatAsInt,
            haspaid: false,
            status: 'unconfirmed'
          });
          return seatAsInt;
        } catch (error) {
          logger.error("Error assigning seat:", error);
        }
      }
    }
  }

  return null;
}

const UNCONFIRMED_SEAT_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

async function releaseUnconfirmedSeats() {
  const expiryTime = UNCONFIRMED_SEAT_EXPIRY_MS;
  const expiredTimestamp = new Date(Date.now() - expiryTime);

  await EventUsersModel.update(
    { status: 'available' },
    {
      where: {
        status: 'reserved',
        updatedAt: { [Op.lte]: expiredTimestamp }
      }
    }
  );
}

/* -------------------- Seating map / channel updates -------------------- */

async function fetchOccupiedSeatsForEvent(eventID) {
  try {
    const rows = await EventUsersModel.findAll({
      where: { eventId: eventID, seat: { [Op.ne]: null } },
      include: { model: UserModel, as: 'user', attributes: ['nickname'] }
    });
    return rows.map(r => ({
      seatId: String(r.seat),
      nickname: r.user?.nickname ?? 'Unknown',
      hasPaid: !!r.haspaid
    }));
  } catch (error) {
    logger.error('Error fetching occupied seats:', error);
    return [];
  }
}

async function generateCurrentSeatingMap(eventID) {
  const [eventRow, occupied] = await Promise.all([
    EventModel.findByPk(eventID),
    fetchOccupiedSeatsForEvent(eventID)
  ]);
  if (!eventRow) throw new Error('Event not found');

  const pngBuffer = await renderMapForEvent(
    eventRow,
    occupied,
    (config.seating?.overlay?.pending) || 'rgba(255,160,0,0.5)',
    (config.seating?.overlay?.occupied) || 'rgba(230,20,20,0.5)'
  );
  return pngBuffer;
}

function truncateNickname(nickname) {
  return nickname.length > 12 ? nickname.substring(0, 10) + '..' : nickname;
}

// Hard purge channel (handles old messages too)
async function purgeChannel(channel) {
  try {
    let fetched;
    do {
      fetched = await channel.messages.fetch({ limit: 100 });
      const newer = fetched.filter(m => Date.now() - m.createdTimestamp < 14 * 24 * 60 * 60 * 1000);
      const older = fetched.filter(m => !newer.has(m.id));

      if (newer.size > 0) {
        await channel.bulkDelete(newer, true);
      }
      // delete older one by one (Discord doesn't bulk-delete >14d)
      for (const m of older.values()) {
        try { await m.delete(); } catch {}
      }
    } while (fetched.size >= 2); // loop until nearly empty
  } catch (e) {
    logger.error(`purgeChannel error: ${e.message}`);
  }
}

async function createEventEmbed(eventId) {
  try {
    const event = await EventModel.findByPk(eventId, {
      include: [{
        model: UserModel,
        as: 'users',
        through: { where: { haspaid: true } },
        required: false
      }]
    });

    const embed = new EmbedBuilder()
      .setTitle(`Participants for ${event.name}`)
      .setColor('#0089E4')
      .setDescription(event.users.map(user => user.nickname).join('\n'));

    return embed;
  } catch (error) {
    logger.error(`Error creating embed for eventId ${eventId}:`, error);
    return null;
  }
}

async function updateParticipantList(client, eventId) {
  try {
    const event = await EventModel.findByPk(eventId, {
    include: [{
        model: UserModel,
        as: 'users',
        through: {
            where: {
                haspaid: true,
                reserve: false,
                seat: { [Op.ne]: null }   // exclude null seat
            }
        },
        required: false
    }]
    });

    if (!event) return;

    // Build participant embed description
    let embedDescription = "* *Only participants who have paid the entry fee are included in this list.*\n\n**#** **| Country | Nick | Seat**\n";

    const DESIRED_NICKNAME_LENGTH = 18;

    // Validate rows
    let invalidUsers = 0;
    event.users.forEach(user => {
      if (!user.EventUsers || !user.EventUsers.paidAt) {
        invalidUsers++;
        logger.error(`User ${user.nickname} has invalid EventUsers data`);
      }
    });
    if (invalidUsers > 0) {
      logger.error(`${invalidUsers} users have invalid data. Stopping further processing.`);
      return;
    }

    event.users
      .sort((a, b) => new Date(a.EventUsers.paidAt) - new Date(b.EventUsers.paidAt))
      .forEach((user, index) => {
        try {
          const number = String(index + 1).padStart(2, '0');
          const flagEmoji = `:flag_${user.country.toLowerCase()}:`;
          if (user.EventUsers) {
            const computedPadding = DESIRED_NICKNAME_LENGTH - user.nickname.length;
            const padding = ' '.repeat(Math.max(0, computedPadding));
            const safeNick = user.nickname.replace(/`/g, '');
            embedDescription += `\` ${number} \` ${flagEmoji} \` ${safeNick} ${padding}\` (**${user.EventUsers.seat}**)\n`;
          } else {
            logger.warn(`EventUsers association missing for user: ${user.nickname}`);
          }
        } catch (err) {
          logger.error(`Error processing user with nickname: ${user.nickname}. Error: ${err.message}`);
        }
      });

    const matchResult = event.participantchannel?.match(/\d+/);
    if (!matchResult || matchResult.length === 0) {
      logger.error(`Failed to extract channel ID from ${event.participantchannel}`);
      return;
    }

    const channelId = matchResult[0];
    const channel = client.channels.cache.get(channelId);
    if (!channel) {
      logger.error(`Channel with ID ${event.participantchannel} not found or not accessible.`);
      return;
    }
    if (channel.type !== 0) {
      logger.error(`Channel with ID ${channel.id} is not a text channel.`);
      return;
    }

    // Purge everything to avoid lingering old embeds (like reserves)
    await purgeChannel(channel);

    // Generate and send the seating map
    const seatingMapBuffer = await generateCurrentSeatingMap(eventId);
    await channel.send({
      files: [{ attachment: seatingMapBuffer, name: 'seating-map.png' }]
    });

    // Send the participants embed
    const embed = {
      title: "**PARTICIPANT LIST**",
      description: embedDescription,
      color: 7907404,
      footer: {
        text: "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀"
      }
    };
    await channel.send({ embeds: [embed] });

    // Reserves
    const reserveUsers = await getReserveUsersForEvent(eventId);
    if (reserveUsers.length > 0) {
      const reserveEmbed = createReserveListEmbed(reserveUsers);
      await channel.send({ embeds: [reserveEmbed] });
    }
  } catch (error) {
    logger.error(`Error updating participant list for eventId ${eventId}:`, error);
  }
}

async function getReserveUsersForEvent(eventId) {
  return await EventUsersModel.findAll({
    where: { eventId, reserve: true },
    include: { model: UserModel, as: 'user' },
    order: [['createdAt', 'ASC']]
  });
}

function createReserveListEmbed(reserveUsers) {
  let embedDescription = '**#** **| Country | Nick**\n';

  reserveUsers.forEach((reserveUser, index) => {
    const flagEmoji = `:flag_${reserveUser.user.country.toLowerCase()}:`;
    const formattedIndex = (index + 1).toString().padStart(2, '0');
    embedDescription += `\`${formattedIndex}. \` ${flagEmoji} \` ${reserveUser.user.nickname} \`\n`;
  });

  return {
    title: "**RESERVES LIST**",
    description: embedDescription,
    color: 11027200,
    footer: {
      text: "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀"
    }
  };
}

async function getAvailableSeatsForEvent(eventId, editingUserId = null) {
  try {
    // Fetch the total number of seats for the event
    const event = await EventModel.findByPk(eventId);
    if (!event) {
      return { success: false, error: "Event not found." };
    }

    let totalSeats = Number(event.seatsavailable || 0);
    try {
      if (event.chartId) {
        const { chart } = await loadChartById(event.chartId);
        totalSeats = Array.isArray(chart.seats) ? chart.seats.length : totalSeats;
      }
    } catch {
      // fallback to seatsavailable if chart missing
    }

    const where = { eventId, seat: { [Op.ne]: null } };
    if (editingUserId) where.userId = { [Op.ne]: editingUserId };

    const occupiedSeatsCount = await EventUsersModel.count({ where });
    const availableSeats = totalSeats - occupiedSeatsCount;

    return { success: true, availableSeats, totalSeats, eventName: event.name };
  } catch (error) {
    logger.error(`Error in getAvailableSeatsForEvent for eventId ${eventId} and editingUserId: ${editingUserId}. Error: ${error.message}`);
    return { success: false, error: error.message };
  }
}

/* -------------------- Nickname + Temp Reg -------------------- */

async function isNicknameAvailable(userId, desiredNickname) {
  let currentUser;

  try {
    currentUser = await UserModel.findOne({ where: { discorduser: userId } });
  } catch (error) {
    logger.error("Error fetching user based on userId:", error.message);
    return false;
  }

  if (currentUser && currentUser.nickname === desiredNickname) {
    return true;
  }

  try {
    const existingUserWithNickname = await UserModel.findOne({ where: { nickname: desiredNickname } });
    const ongoingRegistrationWithNickname = await TemporaryRegistration.findOne({ where: { nickname: desiredNickname } });

    if (!existingUserWithNickname && !ongoingRegistrationWithNickname) {
      return true;
    }

    if (existingUserWithNickname || (ongoingRegistrationWithNickname && ongoingRegistrationWithNickname.discorduser !== userId)) {
      return false;
    }
  } catch (error) {
    logger.error("Error checking nickname availability:", error.message);
    return false;
  }

  return false;
}

async function handleTempRegistration(interaction, stage, eventName, eventId, user = null) {
  const existingTempReg = await TemporaryRegistration.findOne({
    where: { discorduser: interaction.user.id }
  });

  const registrationData = {
    stage,
    event: eventName,
    eventId,
    discorduser: interaction.user.id
  };

  if (user) {
    registrationData.nickname = user.nickname;
    registrationData.firstname = user.firstname;
    registrationData.lastname = user.lastname;
    registrationData.email = user.email;
    registrationData.country = user.country;
  }

  if (existingTempReg) {
    await existingTempReg.update(registrationData);
  } else {
    await TemporaryRegistration.create(registrationData);
  }
}

/* -------------------- Update scheduling -------------------- */

function scheduleParticipantListUpdate(client, eventId) {
  if (!updateScheduled) {
    updateScheduled = true;

    setTimeout(async () => {
      try {
        await updateParticipantList(client, eventId);
      } catch (e) {
        logger.error('Error in scheduleParticipantListUpdate:', e);
      } finally {
        updateScheduled = false;
      }
    }, 5000); // Wait 5 seconds before updating
  }
}

/* -------------------- Exports -------------------- */

module.exports = {
  addEvent,
  addUser,
  getSetting,
  setSetting,
  listUsers,
  listEventsForUser,
  listEvents,
  getEvent,
  checkSeatTaken,
  checkUserInEvent,
  associateUserToEvent,
  moveUserFromReserve,
  deleteEvent,
  deleteUserFromEvent,
  deleteUserCompletely,
  updateEvent,
  updateUser,
  updateEventUser,
  assignSeat,
  releaseUnconfirmedSeats,
  fetchOccupiedSeatsForEvent,
  getAvailableSeatsForEvent,
  generateCurrentSeatingMap,
  truncateNickname,
  updateParticipantList,
  createEventEmbed,
  getReserveUsersForEvent,
  createReserveListEmbed,
  isNicknameAvailable,
  handleTempRegistration,
  scheduleParticipantListUpdate
};
