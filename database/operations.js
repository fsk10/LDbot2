const { EventModel, UserModel, SettingsModel, EventUsersModel } = require('../models/index.js');
const settingsConfig = require('../config/settingsConfig');  
const defaultSettings = Object.keys(settingsConfig);
const logger = require('../utils/logger');

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
async function addUser(userData) {
    try {
        // Step 1: Check if the User Exists
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

        // Step 2: Add or Update Association in EventUsers Table
        const eventUserAssociation = await EventUsersModel.findOne({
            where: {
                userId: user.id,
                eventId: userData.event
            }
        });

        if (eventUserAssociation) {
            // Update the existing association with new event-specific data
            eventUserAssociation.seat = userData.seat;
            eventUserAssociation.haspaid = userData.haspaid;
            // Update any other event-specific fields as needed
            await eventUserAssociation.save();
        } else {
            // Create a new association
            await EventUsersModel.create({
                userId: user.id,
                eventId: userData.event,
                seat: userData.seat,
                haspaid: userData.haspaid,
                // Add any other event-specific fields as needed
            });
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

// Delete an entire event
async function deleteEvent(eventName) {
    const result = await EventModel.destroy({
        where: {
            name: eventName
        }
    });

    if (result === 0) {
        return { success: false, error: `Event "${eventName}" does not exist.` };
    }

    return { success: true };
}

// Delete a user from an event
async function deleteUserFromEvent(username, eventName) {
    const user = await UserModel.findOne({ where: { nickname: username } });
    const event = await EventModel.findOne({ where: { name: eventName } });
    
    if (!user) {
        return { success: false, error: `User "${username}" does not exist.` };
    }
    
    if (!event) {
        return { success: false, error: `Event "${eventName}" does not exist.` };
    }

    const result = await user.removeEvent(event);
    if (result === 0) {
        return { success: false, error: `User "${username}" is not associated with the event "${eventName}".` };
    }

    return { success: true };
}


// Associate user to event
async function associateUserToEvent(userId, eventId) {
    logger.info(`Associating userId: ${userId} with eventId: ${eventId}`);
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


// Get a specific setting
async function getSetting(key) {
    logger.info(`Attempting to get setting with key: ${key}`);  // Log the key being retrieved
    try {
        const setting = await SettingsModel.findOne({ where: { key } });
        if (setting) {
	    logger.info(`Fetched value for key ${key}: ${setting.value}`);
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
	    logger.log(`Setting value in database for setting: ${key} with value: ${value}`);

            setting.value = value;
            await setting.save();
	    logger.log(`Database operation complete.`);
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
        return await UserModel.findAll();
    }
}



const listEvents = async () => {
    try {
        return await EventModel.findAll();
    } catch (error) {
        logger.error('Error fetching events:', error);
        return [];
    }
};

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

module.exports = {
  addEvent,
  addUser,
  getSetting,
  setSetting,
  listUsers,
  listEvents,
  getEvent,
  checkSeatTaken,
  checkUserInEvent,
  associateUserToEvent,
  deleteEvent,
  deleteUserFromEvent
};