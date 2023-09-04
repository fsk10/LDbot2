const { getSetting } = require('../database/operations');
const { ChannelType } = require('discord.js');
const logger = require('./logger');

async function logActivity(client, message) {
    try {
        const logChannelId = await getSetting('logChannel');
        if (!logChannelId || !logChannelId.value) {
            logger.warn("Log channel not set in the settings.");
            return;
        }

        const logChannel = await client.channels.fetch(logChannelId.value);
        if (!logChannel || logChannel.type !== ChannelType.GuildText) {
            logger.error(`Log channel with ID ${logChannelId.value} is not a text channel or doesn't exist.`);
            return;
        }        
    
        logChannel.send(message)

    } catch (error) {
        logger.error("Error occurred while logging activity:", error);
    }
}

module.exports = logActivity;