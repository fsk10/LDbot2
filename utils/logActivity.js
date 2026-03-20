const { getSetting } = require('../database/operations');
const { ChannelType } = require('discord.js');
const logger = require('./logger');

async function logActivity(client, message) {
    let channelId = 'unknown';
    try {
        const logChannelId = await getSetting('logChannel');
        channelId = logChannelId?.value ?? 'not set';
        if (!logChannelId || !logChannelId.value) {
            logger.warn("Log channel not set in the settings.");
            return;
        }

        const logChannel = await client.channels.fetch(logChannelId.value);
        if (!logChannel || logChannel.type !== ChannelType.GuildText) {
            logger.error(`Log channel with ID ${logChannelId.value} is not a text channel or doesn't exist.`);
            return;
        }        
    
        await logChannel.send(message);

    } catch (error) {
        const code = error?.code ?? error?.status ?? 'unknown';
        logger.error(`Error occurred while logging activity (channel: ${channelId}, code: ${code}): ${error?.message ?? error}`);
    }
}

module.exports = logActivity;