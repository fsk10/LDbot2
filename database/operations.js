const { EmbedBuilder } = require('discord.js');
const { EventModel, UserModel, SettingsModel, EventUsersModel, TemporaryRegistration } = require('../models/index.js');
const { Op } = require('sequelize');
const { sequelize } = require('../database/database');
const settingsConfig = require('../config/settingsConfig');  
const defaultSettings = Object.keys(settingsConfig);
const logger = require('../utils/logger');
const Jimp = require('jimp');
const fs = require('fs').promises;
const path = require('path');

// Used in the function "scheduleParticipantListUpdate"
let updateScheduled = false;

// Creates a new event in the database.
async function addEvent(eventData) {
    try {
        await EventModel.create(eventData);
        return { success: true };
    } catch (error) {
        logger.error("Error creating event in database:", error);
        return { success: false, error: error.message };
    }
}

// Adds a user to an event in the database.
async function addUser(userData, client) {
    try {
        // Check if the User Exists
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

        // Determine if the user should be added as a reserve or a main participant
        const event = await EventModel.findByPk(userData.event);
        const occupiedSeats = await EventUsersModel.count({ where: { eventId: userData.event, reserve: false } });
        
        if (typeof userData.reserve === 'undefined') {
            if (occupiedSeats >= event.seatsAvailable) {
                // Add user to the reserve list
                userData.reserve = true;
            } else {
                userData.reserve = false;
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
            // Update the existing association with new event-specific data
            eventUserAssociation.seat = userData.seat;
            eventUserAssociation.haspaid = userData.haspaid;
            eventUserAssociation.reserve = userData.reserve;
            if (userData.haspaid) {
                eventUserAssociation.paidAt = new Date();
            }
        } else {
            // Create a new association
            eventUserAssociation = await EventUsersModel.create({
                userId: user.id,
                eventId: userData.event,
                seat: userData.seat,
                haspaid: userData.haspaid,
                paidAt: userData.haspaid ? new Date() : null,
                reserve: userData.reserve
            });
        }

        await eventUserAssociation.save();
        
        if (userData.haspaid) {
            // await updateParticipantList(client, userData.event);
            await scheduleParticipantListUpdate(client, userData.event);
        }

        return { success: true, user: user };

    } catch (error) {
        if (error.name === 'SequelizeUniqueConstraintError') {
            // Handle the unique constraint error
            throw new Error('A user with this email already exists.');
        } else {
            // Handle other potential errors
            logger.error("Error adding user to database:", error);
            return { success: false, error: error.message || 'Validation error' };
        }
    }
}

// Update event-data
async function updateEvent(eventId, updatedFields) {
    try {
        // Extract only the numeric ID from the channel mention format
        const channelMention = updatedFields.participantchannel;
        if (channelMention) {
            const channelId = channelMention.match(/\d+/)[0];
            updatedFields.participantchannel = channelId;
        }

        const result = await EventModel.update(updatedFields, {
            where: { id: eventId }
        });

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


// Update data for a user
async function updateUser(nickname, updatedFields, client) {
    try {
        const user = await UserModel.findOne({ where: { nickname: nickname } });
        if (!user) {
            logger.error(`User with nickname "${nickname}" not found.`);
            return { success: false, message: `User "${nickname}" not found.` };
        }

        const result = await UserModel.update(updatedFields, {
            where: { id: user.id }
        });

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
        // If haspaid is being updated, also update the paidAt timestamp
        if ('haspaid' in updatedFields && updatedFields.haspaid) {
            updatedFields.paidAt = new Date();
        }

        const result = await EventUsersModel.update(updatedFields, {
            where: { 
                eventId: eventId,
                userId: userId
            }
        });

        if (result[0] > 0) {
            let shouldUpdateParticipantList = false;

            // If haspaid or reserve is being updated
            if ('haspaid' in updatedFields || 'reserve' in updatedFields) {
                shouldUpdateParticipantList = true;
            }

            // If seat is being updated, we should fetch the haspaid value for the user
            if ('seat' in updatedFields) {
                shouldUpdateParticipantList = true;
                const userEventDetails = await EventUsersModel.findOne({
                    where: { 
                        eventId: eventId,
                        userId: userId
                    }
                });
                
                if (userEventDetails && userEventDetails.haspaid) {
                    shouldUpdateParticipantList = true;
                }
            }

            // Update the participant list if necessary
            if (shouldUpdateParticipantList) {
                await updateParticipantList(client, eventId);
            }

            return { success: true };
        } else {
            return { success: false, message: 'Event-user relation not found or no fields updated.' };
        }
    } catch (error) {
        logger.error(`Error updating event-user relation with eventId: ${eventId}, userId: ${userId}: ${error.message}`);
        return { success: false, error: error.message };
    }
}


// Delete an entire event
async function deleteEvent(eventId) {
    // Fetch the event first
    const event = await EventModel.findOne({ where: { id: eventId } });

    // If the event doesn't exist, return an error
    if (!event) {
        return { success: false, error: `Event with ID "${eventId}" does not exist.` };
    }

    // Store the event's name for user-friendly messages
    const eventName = event.name;

    // Attempt to delete the event
    const result = await EventModel.destroy({
        where: {
            id: eventId
        }
    });

    if (result === 0) {
        return { success: false, error: `Failed to delete event "${eventName}".` };
    }

    return { success: true, eventName: eventName };
}


// Delete a user from an event
async function deleteUserFromEvent(nickname, eventName, client) {
    const user = await UserModel.findOne({ where: { nickname: nickname } });
    const event = await EventModel.findByPk(eventName);

    if (!user) {
        return { success: false, error: `User "${nickname}" does not exist.` };
    }
    
    if (!event) {
        return { success: false, error: `Event "${eventName}" does not exist.` };
    }

    const result = await user.removeEvent(event);
    if (result === 0) {
        return { success: false, error: `User "${nickname}" is not associated with the event "${eventName}".` };
    }

    // Update the participant list for the event after removing the user.
    await updateParticipantList(client, event.id);

    return { success: true, eventName: event.name };
}

// Delete a user from the database completely
async function deleteUserCompletely(nickname, client) {
    try {
        // Find the user based on the nickname
        const user = await UserModel.findOne({ 
            where: { nickname: nickname },
            include: { model: EventModel, as: 'events' }  // Fetch associated events
        });

        if (!user) {
            return { success: false, message: `User with nickname "${nickname}" not found.` };
        }

        // Delete the user's associations with events
        await EventUsersModel.destroy({
            where: { userId: user.id }
        });

        // Update participant list for each event the user was associated with.
        for (const event of user.events) {
            await updateParticipantList(client, event.id);
        }

        // Delete the user from the users table
        await UserModel.destroy({
            where: { id: user.id }
        });

        return { success: true };

    } catch (error) {
        logger.error('Error deleting user:', error);
        return { success: false, error: error.message };
    }
}

// Associate user to event
async function associateUserToEvent(userId, eventId) {
    try {
        await EventUsersModel.create({
            userId: userId,
            eventId: eventId
        });
        return { success: true };
    } catch (error) {
        logger.error("Error associating user to event:", error);
        return { success: false, error: error.message || 'Validation error' };
    }
}

// Move user from the reserves list
async function moveUserFromReserve(userId, eventId) {
    try {
        const user = await EventUsersModel.findOne({ where: { userId, eventId } });
        if (!user) {
            return { success: false, error: "User not found in the event" };
        }

        if (!user.reserve) {
            return { success: false, error: "User is not in the reserve list" };
        }

        // Get the first available seat
        const occupiedSeats = await EventUsersModel.findAll({ 
            where: { eventId, reserve: false },
            attributes: ['seat'],
            order: [['seat', 'ASC']]
        }).map(seatObj => seatObj.seat);

        let seatToAssign = 1;
        while (occupiedSeats.includes(seatToAssign)) {
            seatToAssign++;
        }

        // Update the user's seat and reserve status
        user.seat = seatToAssign;
        user.reserve = false;
        await user.save();

        return { success: true };

    } catch (error) {
        return { success: false, error: error.message };
    }
}


// Get a specific setting
async function getSetting(key) {
    try {
        const setting = await SettingsModel.findOne({ where: { key } });
        if (setting) {
            return { success: true, value: setting.value };
        } else {
            logger.error(`Setting with key ${key} not found in the database`);  // Log if not found
            return { success: false, message: "Setting not found." };
        }
    } catch (error) {
        logger.error("Error fetching setting:", error);
        return { success: false, message: error.message };
    }
}

// Set a specific setting
async function setSetting(key, value) {

    // Check if the setting is allowed
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
            // Return error if the setting doesn't exist in the database
            return { success: false, message: "Setting does not exist." };
        }
    } catch (error) {
        logger.error("Error setting value:", error);
        return { success: false, message: error.message };
    }
}

// List all users from an event
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
        // Fetch all users from the users table along with their associated events
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

        return userWithEvents.events; // This will give you an array of events associated with the user
    } catch (error) {
        logger.error('Error listing events for user:', error);
        return [];
    }
}

// List all events from the events table
async function listEvents(options = {}) {
    const { all = false, archived = false } = options;

    if (all) {
        return await EventModel.findAll();
    } else if (archived) {
        return await EventModel.findAll({
            where: {
                enddate: {
                    [Op.lt]: new Date()
                }
            }
        });
    } else {
        return await EventModel.findAll({
            where: {
                enddate: {
                    [Op.gte]: new Date()
                }
            }
        });
    }
}

// Fetch event data based on ID
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
        const seatTaken = await EventUsersModel.findOne({
            where: {
                eventId: eventID,
                seat: seatNumber
            }
        });
        return !!seatTaken;  // Returns true if a seat is found, otherwise false
    } catch (error) {
        logger.error('Error checking seat:', error);
        return false;
    }
}

async function checkUserInEvent(discordUserId, eventId) {
    try {
        // Check the association table for the user-event combination
        const association = await EventUsersModel.findOne({
            where: { 
                userId: discordUserId,
                eventId: eventId
            }
        });
        return !!association;  // Returns true if an association is found, otherwise false
    } catch (error) {
        logger.error('Error checking user in event:', error);
        return false;
    }
}

async function handleDatabaseOperations(interaction, collectedData, eventName) {
	let user = await UserModel.findOne({ where: { discorduser: interaction.user.id } });

	if (!user) {
		user = await UserModel.create({
			discorduser: interaction.user.id,
			nickname: collectedData.nickname,
			firstname: collectedData.firstname,
			// ... Add other fields as necessary...
		});
	}

	const event = await EventModel.findOne({ where: { name: eventName } });

	await EventUsersModel.create({
		userId: user.id,
		eventId: event.id,
		preferredseats: collectedData.preferredSeats
		// ... Add other fields as necessary...
	});
}

async function assignSeat(userId, eventId, preferredSeats) {
    // Ensure the seat array is not empty
    if (!preferredSeats || preferredSeats.length === 0) {
        logger.info("No preferred seats provided.");
        return null;
    }

    // Check if the user exists in the `users` table or create a new record if they don't.
    const tempUserDetails = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
    if (!tempUserDetails) {
        logger.error("Error fetching temporary registration details for user");
        return null;
    }

    const [user, created] = await UserModel.findOrCreate({
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
        logger.error("Error creating or fetching user");
        return null;
    }

    // Get the current seat of the user if they have one
    const currentSeatRecord = await EventUsersModel.findOne({
        where: {
            userId: user.id,
            eventId: eventId
        }
    });

    const currentSeat = currentSeatRecord ? currentSeatRecord.seat : null;

    // Loop through the preferred seats
    for (let i = 0; i < preferredSeats.length; i++) {
        let seat = preferredSeats[i];

        // Check if the seat is available or is the current seat of the user
        const seatTaken = await EventUsersModel.findOne({ 
            where: { 
                eventId: eventId,
                seat: seat 
            } 
        });

        if (!seatTaken || seat === currentSeat) {
            // If seat is available or is the current seat of the user, assign it
            const userEventRecord = await EventUsersModel.findOne({
                where: {
                    userId: user.id,
                    eventId: eventId
                }
            });

            if (userEventRecord) {
                userEventRecord.seat = seat;
                await userEventRecord.save();
                return seat;
            } else {
                try {
                    await EventUsersModel.create({
                        userId: user.id,
                        eventId: eventId,
                        seat: seat,
                        haspaid: false,
                        status: 'unconfirmed'
                    });
                    return seat;
                } catch (error) {
                    logger.error("Error assigning seat:", error);
                    if (error instanceof Sequelize.ValidationError) {
                        for (const validationErrorItem of error.errors) {
                            logger.error(`Validation error on field ${validationErrorItem.path}: ${validationErrorItem.message}`);
                        }
                    }
                }
            }
        }
    }

    // logger.info("All preferred seats are taken.");
    return null;
}

async function releaseUnconfirmedSeats() {
    const expiryTime = 10 * 60 * 1000; // 10 minutes in milliseconds
    const expiredTimestamp = new Date(Date.now() - expiryTime);

    await EventUsersModel.update({ 
        status: 'available' 
    }, { 
        where: { 
            status: 'reserved',
            updatedAt: { [Sequelize.Op.lte]: expiredTimestamp }
        } 
    });
}

async function updateSeatingMap(occupiedSeats) {
    const image = await Jimp.read('./images/SeatingMap.png');
    const font = await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK);

    // Create a semi-transparent rectangle
    const takenRectangle = new Jimp(40, 39, 'rgba(230, 20, 20, 0.5)');
    const pendingRectangle = new Jimp(40, 39, 'rgba(255, 160, 0, 0.5)');

    occupiedSeats.forEach(seat => {
        const { seatNumber, nickname, hasPaid } = seat;
        const seatCoord = getSeatCoordinates(seatNumber);

        // Decide which rectangle to use based on the hasPaid field
        const rectangleToUse = hasPaid ? takenRectangle : pendingRectangle;

        // Composite the transparent rectangle onto the main image
        image.composite(rectangleToUse, seatCoord.x + 1, seatCoord.y + 3);

        // Print nickname
        const truncatedNickname = truncateNickname(nickname);
        const nicknameCoord = getNicknameCoordinates(seatNumber, truncatedNickname, font);

        image.print(font, nicknameCoord.x, nicknameCoord.y, truncatedNickname);

    });

    await image.writeAsync('./images/UpdatedSeatingMap.png');
}

function getSeatCoordinates(seatNumber) {
    const baseX = seatNumber <= 20 ? 210 : 462; // Decide the base X based on the seat number
    const baseY = 192;

    let row, col;
    if (seatNumber % 2 === 0) {
        col = 1;  // second column
        row = (seatNumber / 2 - 1) % 10;  // Using modulo 10 to make sure it wraps around after reaching 10
    } else {
        col = 0;  // first column
        row = ((seatNumber + 1) / 2 - 1) % 10;  // Using modulo 10 here as well
    }

    // Calculate the X and Y coordinates based on the seat's position in the grid
    const x = baseX + col * 42;
    const y = baseY + row * 42;

    return { x, y };
}

function getNicknameCoordinates(seatNumber, truncatedNickname, font) {
    const seatCoord = getSeatCoordinates(seatNumber);
    const nicknameWidth = Jimp.measureText(font, truncatedNickname);
    const padding = 5;  // This value can be adjusted as per your needs

    let x, y;

    if (seatNumber % 2 === 1) { // odd seats (left column)
        x = seatCoord.x - nicknameWidth - padding; 
        y = seatCoord.y + 24;
    } else { // even seats (right column)
        x = seatCoord.x + 46; 
        y = seatCoord.y + 6; 
    }

    return { x, y };
}

async function fetchOccupiedSeatsForEvent(eventID) {
    try {
        const occupiedSeats = await EventUsersModel.findAll({
            where: {
                eventId: eventID,
                seat: {
                    [Op.ne]: null  // Make sure the seat is not null
                }
            },
            include: {
                model: UserModel,
                as: 'user',
                attributes: ['nickname']  // Only fetch the nickname
            }
        });

        // Transform the results to an array of { seatNumber, nickname }
        return occupiedSeats.map(record => ({
            seatNumber: record.seat,
            nickname: record.user.nickname,
            hasPaid: record.haspaid
        }));
    } catch (error) {
        logger.error('Error fetching occupied seats:', error);
        return [];
    }
}

async function generateCurrentSeatingMap(eventID) {
    const occupiedSeats = await fetchOccupiedSeatsForEvent(eventID);
    await updateSeatingMap(occupiedSeats);
    
    // Read the image into a buffer and return the buffer
    return await fs.readFile('./images/UpdatedSeatingMap.png');
}

function truncateNickname(nickname) {
    const truncated = nickname.length > 12 ? nickname.substring(0, 10) + '..' : nickname;
    return truncated;
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
                through: { where: { haspaid: true }, order: [['paidAt', 'ASC']] },
                required: false
            }]
        });

        // Constructing the embed description dynamically
        let embedDescription = "\* *Only participants who have paid the entry fee are included in this list.*\n\n**#** **| Country | Nick | Seat**\n";

        const DESIRED_NICKNAME_LENGTH = 18;

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

        event.users.sort((a, b) => new Date(a.EventUsers.paidAt) - new Date(b.EventUsers.paidAt)).forEach((user, index) => {
            try {
                const number = String(index + 1).padStart(2, '0');
                const flagEmoji = `:flag_${user.country.toLowerCase()}:`;

                // Check if EventUsers is defined for the user
                if (user.EventUsers) {
                    // Compute the padding needed for this nickname
                    const computedPadding = DESIRED_NICKNAME_LENGTH - user.nickname.length;
                    const padding = ' '.repeat(Math.max(0, computedPadding));
                    embedDescription += `\` ${number} \` ${flagEmoji} \` ${user.nickname} ${padding}\` (**${user.EventUsers.seat}**)\n`;
                } else {
                    logger.warn(`EventUsers association missing for user: ${user.nickname}`);
                }

            } catch (err) {
            logger.error(`Error processing user with nickname: ${user.nickname}. Error: ${err.message}`);
            }
        });

        const matchResult = event.participantchannel.match(/\d+/);
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

        // Fetch and bulk delete all messages in the channel
        const fetchedMessages = await channel.messages.fetch({ limit: 100 });
        if (fetchedMessages.size > 0) {
            try {
                await channel.bulkDelete(fetchedMessages);
            } catch (error) {
                logger.error(`Failed to bulk delete messages. Error: ${error.message}`);
            }
        }

        // Generate and send the seating map
        const seatingMapBuffer = await generateCurrentSeatingMap(eventId);
        await channel.send({
            files: [{
                attachment: seatingMapBuffer,
                name: 'seating-map.png'
            }]
        });

        // Send the new embed
        const embed = {
            title: "**PARTICIPANT LIST**",
            description: embedDescription,
            color: 7907404,
            footer: {
                text: "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀"
            }
        };
        channel.send({ embeds: [embed] });

        // Fetch the reserve users and send the reserves list embed
        const reserveUsers = await getReserveUsersForEvent(eventId);
        if (reserveUsers.length > 0) {  // Check if there are any reserve users
            const reserveEmbed = createReserveListEmbed(reserveUsers);
            channel.send({ embeds: [reserveEmbed] });
        }

    } catch (error) {
        logger.error(`Error updating participant list for eventId ${eventId}:`, error);
    }
}

async function getReserveUsersForEvent(eventId) {
    return await EventUsersModel.findAll({
        where: {
            eventId: eventId,
            reserve: true
        },
        include: {
            model: UserModel,
            as: 'user'
        },
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

    const reserveEmbed = {
        title: "**RESERVES LIST**",  // This sets the title for the reserves list embed
        description: embedDescription,
        color: 11027200,
        footer: {
            text: "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀"
        }
    };

    return reserveEmbed;
}

async function getAvailableSeatsForEvent(eventId, editingUserId = null) {
    try {
        logger.info(`getAvailableSeatsForEvent called with eventId: ${eventId} and editingUserId: ${editingUserId}`); //debug

        // Fetch the total number of seats for the event
        const event = await EventModel.findByPk(eventId);
        if (!event) {
            logger.error(`Event not found for eventId: ${eventId}`); //debug
            return { success: false, error: "Event not found." };
        }

        const totalSeats = event.seatsavailable;

        logger.info(`Fetched event details. Total Seats for eventId ${eventId}: ${totalSeats}`); //debug

        const occupiedSeatsWhereClause = {
            eventId: eventId,
            seat: {
                [Op.ne]: null  // Ensure the seat is not null
            }
        };

        // Exclude the user who is currently editing their registration
        if (editingUserId) {
            occupiedSeatsWhereClause.userId = {
                [Op.ne]: editingUserId
            };
        }

        logger.info(`Where clause for occupied seats: ${JSON.stringify(occupiedSeatsWhereClause)}`); //debug

        // Fetch the number of occupied seats for the event
        const occupiedSeatsCount = await EventUsersModel.count({
            where: occupiedSeatsWhereClause
        });

        logger.info(`Occupied Seats Count for eventId ${eventId}: ${occupiedSeatsCount}`); //debug

        // Calculate the number of available seats
        const availableSeats = totalSeats - occupiedSeatsCount;

        logger.info(`Calculated available seats for eventId ${eventId}: ${availableSeats}`); //debug

        return { success: true, availableSeats: availableSeats, totalSeats: totalSeats, eventName: event.name };
    } catch (error) {
        logger.error(`Error in getAvailableSeatsForEvent for eventId ${eventId} and editingUserId: ${editingUserId}. Error: ${error.message}`);
        return { success: false, error: error.message };
    }
}


async function isNicknameAvailable(userId, desiredNickname) {
    let currentUser;
    
    // Try fetching the current user's nickname
    try {
        currentUser = await UserModel.findOne({ where: { discorduser: userId } });
    } catch (error) {
        logger.error("Error fetching user based on userId:", error.message);
        return false;
    }

    // If the desired nickname matches the current user's nickname, allow it
    if (currentUser && currentUser.nickname === desiredNickname) {
        return true;
    }

    // If the desired nickname doesn't match the current one, check for its uniqueness in both UserModel and TemporaryRegistration
    try {
        const existingUserWithNickname = await UserModel.findOne({ where: { nickname: desiredNickname } });
        const ongoingRegistrationWithNickname = await TemporaryRegistration.findOne({ where: { nickname: desiredNickname } });
        
        // If no user is found with the desired nickname in both models, it's available
        if (!existingUserWithNickname && !ongoingRegistrationWithNickname) {
            return true;
        }

        // If we found another user with the desired nickname, or it's in the process of registration, it's not available
        if (existingUserWithNickname || (ongoingRegistrationWithNickname && ongoingRegistrationWithNickname.discorduser !== userId)) {
            return false;
        }

    } catch (error) {
        logger.error("Error checking nickname availability:", error.message);
        return false;
    }

    // Default to false for any unhandled cases
    return false;
}

async function handleTempRegistration(interaction, stage, eventName, eventId, user = null) {
    const existingTempReg = await TemporaryRegistration.findOne({ 
        where: { 
            discorduser: interaction.user.id 
        } 
    });

    const registrationData = {
        stage: stage,
        event: eventName,
        eventId: eventId,
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

function scheduleParticipantListUpdate(client, eventId) {
    if (!updateScheduled) {
        updateScheduled = true;

        setTimeout(() => {
            updateParticipantList(client, eventId);
            updateScheduled = false;
        }, 5000);  // Wait 5 seconds before updating
    }
}



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
  handleDatabaseOperations,
  assignSeat,
  releaseUnconfirmedSeats,
  updateSeatingMap,
  getSeatCoordinates,
  getNicknameCoordinates,
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