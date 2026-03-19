const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const {
  addEvent,
  addUser,
  getEvent,
  checkSeatTaken,
  listEvents,
  checkUserInEvent,
  updateParticipantList,
  scheduleParticipantListUpdate
} = require('../../database/operations');
const { UserModel, EventModel, EventUsersModel } = require('../../models');
const options = require('../../config/adminAddConfig');
const countryList = require('../../config/countryList');
const extractOption = require('../../utils/extractOption');
const { isAdmin } = require('../../utils/permissions');
const { getNameFromID } = require('../../utils/getNameFromID');
const logActivity = require('../../utils/logActivity');
const { formatEventUserLog, formatEventUserDiffLog, bulletEventField } = require('../../utils/activityFormat');
const { listPaymentConfigFiles } = require('../../utils/payment');
const { parseLocalToUTC } = require('../../utils/dateUtils');

const data = new SlashCommandBuilder()
  .setName('adminadd')
  .setDescription('Add an event, a user, or link an existing user to an event');

// keep your config-driven subcommands
const addOptionToCommand = (opt, command) => {
  switch (opt.type) {
    case 'STRING':
      command.addStringOption(option => {
        option
          .setName(opt.name)
          .setDescription(opt.description)
          .setRequired(opt.required);
        if (opt.autocomplete) option.setAutocomplete(true);
        return option;
      });
      break;
    case 'INTEGER':
      command.addIntegerOption(option =>
        option.setName(opt.name)
          .setDescription(opt.description)
          .setRequired(opt.required));
      break;
    case 'USER':
      command.addUserOption(option =>
        option.setName(opt.name)
          .setDescription(opt.description)
          .setRequired(opt.required));
      break;
    case 'BOOLEAN':
      command.addBooleanOption(option =>
        option.setName(opt.name)
          .setDescription(opt.description)
          .setRequired(opt.required));
      break;
    case 'ROLE':
      command.addRoleOption(option =>
        option.setName(opt.name)
          .setDescription(opt.description)
          .setRequired(opt.required));
      break;
  }
};

for (let subCommandName in options) {
  data.addSubcommand(subcommand => {
    subcommand.setName(subCommandName)
      .setDescription(`Add a new ${subCommandName}`);
    options[subCommandName].forEach(option => {
      addOptionToCommand(option, subcommand);
    });
    return subcommand;
  });
}

// subcommand to attach an existing user to an event
data.addSubcommand(sub =>
  sub.setName('eventuser')
    .setDescription('Add/update a user in a specific event')
    .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('nickname').setDescription('User nickname').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('seat').setDescription('Seat number (omit for reserve)'))
    .addBooleanOption(o => o.setName('haspaid').setDescription('Mark as paid'))
    .addBooleanOption(o => o.setName('reserve').setDescription('Add as reserve'))
);

async function execute(interaction, client) {
  // perms
  const userIsAdmin = await isAdmin(interaction);
  if (!userIsAdmin) {
    const permissionErrorEmbed = new EmbedBuilder()
      .setTitle('Permission Denied')
      .setDescription("You don't have the required permissions to use this command.")
      .setColor('#FF0000');
    return interaction.reply({ embeds: [permissionErrorEmbed], ephemeral: true });
  }

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'event') {
    try {
      let eventData = {};

      const startDateStr = interaction.options.getString('startdate');
      const endDateStr   = interaction.options.getString('enddate');

      const startDateObj = parseLocalToUTC(startDateStr); // Europe/Stockholm → UTC
      const endDateObj   = parseLocalToUTC(endDateStr);

      if (!startDateObj || !endDateObj) {
        return await interaction.reply({
          content: 'Invalid date-time. Use **YYYY-MM-DD HH:mm** (local Stockholm time).',
          ephemeral: true
        });
      }

      if (startDateObj > endDateObj) {
        return await interaction.reply({
          content: 'Start date cannot be after end date. Please correct the dates.',
          ephemeral: true
        });
      }

      // Write parsed UTC dates
      eventData.startdate = startDateObj;
      eventData.enddate   = endDateObj;


      const channelMention = interaction.options.getString('participantchannel');
      if (channelMention) {
        const channelIdMatch = channelMention.match(/<#(\d+)>/);
        if (!channelIdMatch) {
          return await interaction.reply({
            content: 'Invalid channel mention. Please provide a valid channel mention.',
            ephemeral: true
          });
        }

        const channelId = channelIdMatch[1];
        const channel = client.channels.cache.get(channelId);
        if (!channel) {
          logger.error(`Channel with ID ${channelId} not found in the cache.`);
          return await interaction.reply({
            content: 'Invalid channel ID. Please provide a valid channel ID.',
            ephemeral: true
          });
        }

        if (channel.type !== 0) {
          return await interaction.reply({
            content: `Invalid channel type. Expected GUILD_TEXT but found ${channel.type}.`,
            ephemeral: true
          });
        }

        eventData['participantchannel'] = channelId;
      } else {
        eventData['participantchannel'] = null;
      }

      // Copy in configured fields from your adminAddConfig
      for (let optionConfig of options[subcommand]) {
        const optionName = optionConfig.name;
        eventData[optionName] = extractOption(optionName, interaction, optionConfig.extractionMethod);
      }

      // ---- Normalize & save adminrole (role picker only) ----
      {
        const rolePicked = interaction.options.getRole('adminrole');
        if (rolePicked) {
          eventData.adminrole = rolePicked.id; // store ID
        }
      }

      // ---- NEW: per-event payment config ----
      {
        const rawOpt = interaction.options.getString('paymentconfig');
        const raw = (rawOpt ?? eventData.paymentconfig ?? '').trim();

        // Treat '', 'none', 'clear', or 'default' as "use global" (null in DB)
        if (!raw || ['none', 'clear', 'default'].includes(raw.toLowerCase())) {
          eventData.paymentconfig = null;
        } else {
          // Accept either "paymentConfig_Sweden" or "paymentConfig_Sweden.json"
          const base = raw.replace(/\.json$/i, '');
          const cfgPath = path.join(process.cwd(), 'config', `${base}.json`);

          if (!fs.existsSync(cfgPath)) {
            return await interaction.reply({
              content: `Payment config **${base}.json** was not found in /config.`,
              ephemeral: true
            });
          }

          // store base name (no .json) in DB
          eventData.paymentconfig = base;
        }
      }

      // Ensure regopen has a value (default false = closed)
      {
        const ro = interaction.options.getBoolean('regopen');
        if (typeof ro === 'boolean') {
          eventData.regopen = ro;
        } else {
          eventData.regopen = false; // default closed
        }
      }

      const result = await addEvent(eventData);

      if (result.success) {
        const lines = [];
        if (Object.prototype.hasOwnProperty.call(eventData, 'paymentconfig')) {
          lines.push(bulletEventField('paymentconfig', eventData.paymentconfig)); // “Payment Config: Sweden”
        }
        if (Object.prototype.hasOwnProperty.call(eventData, 'adminrole')) {
          lines.push(bulletEventField('adminrole', eventData.adminrole));         // “Event Adminrole: @Role”
        }

        const header = `Event **${eventData.name}** was **added** by [ **${interaction.user.tag}** ]`;
        logActivity(client, [header, ...lines].join('\n'));

        await interaction.reply({ content: `✅ Saved.`, ephemeral: true });
      } else {
        await interaction.reply({
          content: 'Error adding event. Please try again.',
          ephemeral: true
        });
      }
    } catch (error) {
      logger.error('Error executing adminadd event command:', error);
      await interaction.reply({
        content: 'An error occurred while adding the event. Please try again.',
        ephemeral: true
      });
    }

  } else if (subcommand === 'user') {
    try {
      const userData = {};
      for (let optionConfig of options[subcommand]) {
        const optionName = optionConfig.name;
        userData[optionName] = extractOption(optionName, interaction, optionConfig.extractionMethod);
      }

      const isReserve = userData.reserve;
      const eventId = interaction.options.getInteger('event');
      const event = await getEvent(eventId);
      if (!event) {
        return await interaction.reply({
          content: 'The specified event does not exist.',
          ephemeral: true
        });
      }

      const userExists = await checkUserInEvent(userData.discorduser, eventId);
      if (userExists) {
        return await interaction.reply({
          content: `User with ID ${userData.discorduser} is already registered for event ${event.name}.`,
          ephemeral: true
        });
      }

      if (isReserve) {
        userData.seat = null;
      } else {
        // NOTE: field is seatsavailable in DB
        if (userData.seat > event.seatsavailable) {
          return await interaction.reply({
            content: `The seat number exceeds the available seats for this event. Maximum seat number is ${event.seatsavailable}.`,
            ephemeral: true
          });
        }
        const isSeatTaken = await checkSeatTaken(eventId, userData.seat);
        if (isSeatTaken) {
          return await interaction.reply({
            content: 'The specified seat is already taken for this event. Please choose a different seat.',
            ephemeral: true
          });
        }
      }

      const nameResult = await getNameFromID(interaction, userData.discorduser);
      let displayName = userData.discorduser;
      if (nameResult && nameResult.type === 'user') {
        displayName = nameResult.name;
      }

      const result = await addUser(userData, client);
      if (result.success) {
        if (isReserve) {
          logActivity(client, `User **${displayName}** (${userData.nickname}) was added as a reserve to event **${event.name}** by [ **${interaction.user.tag}** ]`);
        } else {
          logActivity(client, `User **${displayName}** (${userData.nickname}) was added to event **${event.name}** by [ **${interaction.user.tag}** ]`);
        }
        await interaction.reply({ content: `✅ Saved.`, ephemeral: true });

        // debounce to avoid duplicate refreshes
        await scheduleParticipantListUpdate(client, eventId);
      } else {
        await interaction.reply({
          content: result.error || 'Error adding user. Please try again.',
          ephemeral: true
        });
      }

    } catch (error) {
      logger.error('Caught Error Message:', error.message);
      if (error.message === 'A user with this email already exists.') {
        await interaction.reply({ content: error.message, ephemeral: true });
      } else {
        await interaction.reply({
          content: 'An error occurred while adding the user. Please try again.',
          ephemeral: true
        });
      }
    }
  } else if (subcommand === 'eventuser') {
    try {
      // inputs
      const eventIdStr = interaction.options.getString('event', true); // autocomplete returns ID string
      const nickname   = interaction.options.getString('nickname', true);
      const seatOpt    = interaction.options.getInteger('seat');       // optional
      const hasPaidOpt = interaction.options.getBoolean('haspaid');    // optional
      const reserveOpt = interaction.options.getBoolean('reserve');    // optional

      // resolve event
      const eventId = Number(eventIdStr);
      const event = await getEvent(eventId);
      if (!event) {
        return interaction.reply({ content: `No event found with ID **${eventIdStr}**.`, ephemeral: true });
      }

      // resolve user by nickname
      const user = await UserModel.findOne({ where: { nickname: { [Op.like]: nickname } } });
      if (!user) {
        return interaction.reply({ content: `No user found with the nickname **${nickname}**.`, ephemeral: true });
      }

      // ----- INTENT PATCH -----
      // If a seat is provided but reserve is not, assume reserve = false (move to main).
      let intendedReserve;
      if (typeof reserveOpt === 'boolean') {
        intendedReserve = reserveOpt;
      } else if (typeof seatOpt === 'number') {
        intendedReserve = false;
      } else {
        intendedReserve = undefined; // no change
      }

      const intended = {
        seat: (intendedReserve === true) ? null
             : (typeof seatOpt === 'number' ? seatOpt : undefined), // INTEGER in DB
        haspaid: (typeof hasPaidOpt === 'boolean') ? hasPaidOpt : undefined,
        reserve: intendedReserve
      };
      // ----- END INTENT PATCH -----

      // if giving a seat (reserve false) → check availability
      if (intended.reserve === false && typeof intended.seat === 'number') {
        const taken = await EventUsersModel.findOne({
          where: {
            eventId,
            seat: intended.seat,
            userId: { [Op.ne]: user.id } // taken by someone else?
          }
        });
        if (taken) {
          return interaction.reply({
            content: `Seat **${intended.seat}** is already taken in **${event.name}**.`,
            ephemeral: true
          });
        }
      }

      // find existing association
      let eventUser = await EventUsersModel.findOne({ where: { userId: user.id, eventId } });

      // gather "before" for logging diffs
      const before = eventUser ? {
        seat: eventUser.seat,
        haspaid: !!eventUser.haspaid,
        reserve: !!eventUser.reserve,
        paidAt: eventUser.paidAt || null
      } : null;

      if (!eventUser) {
        // create new association with safe defaults (haspaid only if provided)
        eventUser = await EventUsersModel.create({
          userId: user.id,
          eventId,
          seat: intended.seat ?? null,
          haspaid: intended.haspaid ?? false,
          paidAt: (intended.haspaid ? new Date() : null),
          reserve: intended.reserve ?? false,
          status: 'confirmed'
        });

        // unified log (creation)
        logActivity(client, formatEventUserLog(interaction.user.tag, {
          action: 'added',
          eventName: event.name,
          eventId: event.id,
          nick: nickname,
          userId: user.id,
          seat: eventUser.reserve ? null : eventUser.seat,
          paid: !!eventUser.haspaid,
          reserve: !!eventUser.reserve,
          paidAt: eventUser.paidAt || null
        }));

        await scheduleParticipantListUpdate(client, eventId);
        return interaction.reply({ content: `✅ Saved.`, ephemeral: true });
      }

      // update existing row (only the fields that were provided)
      const patch = {};
      if ('reserve' in intended) patch.reserve = intended.reserve;
      if ('seat'    in intended) patch.seat    = intended.seat; // may be null if reserve true
      if ('haspaid' in intended) {
        patch.haspaid = intended.haspaid;
        // when explicitly marking unpaid -> clear paidAt; when marking paid -> set now
        patch.paidAt  = intended.haspaid ? new Date() : null;
      }
      if (patch.reserve === true) patch.seat = null; // reserve implies no seat

      await eventUser.update(patch);

      // build diffs
      const after = {
        seat: eventUser.seat,
        haspaid: !!eventUser.haspaid,
        reserve: !!eventUser.reserve,
        paidAt: eventUser.paidAt || null
      };

      const diffs = [];
      if ((before?.seat ?? null) !== (after.seat ?? null)) {
        diffs.push({ label: 'Seat', before: before?.seat ?? null, after: after.seat ?? null });
      }
      if ((before?.haspaid ?? false) !== (after.haspaid ?? false)) {
        diffs.push({ label: 'Paid', before: before?.haspaid ?? false, after: after.haspaid ?? false });
      }
      if ((before?.reserve ?? false) !== (after.reserve ?? false)) {
        diffs.push({ label: 'Reserve', before: before?.reserve ?? false, after: after.reserve ?? false });
      }
      // show Paid date only when changing to paid (or changing timestamp)
      if (after.haspaid && after.paidAt && (!before?.paidAt || +new Date(before.paidAt) !== +new Date(after.paidAt))) {
        diffs.push({ label: 'Paid date', before: before?.paidAt ?? null, after: after.paidAt });
      }

      // unified log (diff)
      logActivity(client, formatEventUserDiffLog(interaction.user.tag, {
        eventName: event.name,
        eventId: event.id,
        nick: nickname,
        userId: user.id,
        changes: diffs
      }));

      await scheduleParticipantListUpdate(client, eventId);
      return interaction.reply({ content: `✅ Saved.`, ephemeral: true });

    } catch (err) {
      logger.error('[adminadd eventuser] Error', err);
      if (err?.errors?.length) {
        const details = err.errors.map(e => `${e.path}: ${e.message}`).join('; ');
        return interaction.reply({ content: `❌ Validation error: ${details}`, ephemeral: true });
      }
      return interaction.reply({ content: `❌ Error: ${err.message || 'Unknown error'}`, ephemeral: true });
    }
  }
}

async function prepare() {
  const events = await listEvents();
  const eventChoices = events.map(event => ({
    name: event.name,
    value: event.id.toString()
  }));

  const userSubcommand = data.options.find(option => option.name === 'user');

  // 'user' subcommand event autocomplete enabled
  const eventOption = userSubcommand.options.find(option => option.name === 'event');
  eventOption.autocomplete = true;

  const countryOption = userSubcommand.options.find(option => option.name === 'country');
  countryOption.autocomplete = true;
  delete countryOption.choices;

  // autocomplete paymentconfig choices for the 'event' subcommand
  const eventSub = data.options.find(o => o.name === 'event');
  if (eventSub && Array.isArray(eventSub.options)) {
    const pcOpt = eventSub.options.find(o => o.name === 'paymentconfig');
    if (pcOpt) {
      pcOpt.autocomplete = true;
      delete pcOpt.choices;
    }
  }

  return data;
}

module.exports = {
  data,
  execute,
  prepare
};
