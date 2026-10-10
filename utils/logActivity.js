const { getSetting } = require('../database/operations');
const { EventModel } = require('../models');
const { ChannelType } = require('discord.js');
const logger = require('./logger');

// Posts to the event's own log channel. Returns false if the event has none
// or it can't be used, so the caller falls back to the global log channel.
async function sendToEventLog(client, eventId, message) {
    let channelId = 'not set';
    try {
        const event = await EventModel.findByPk(eventId, { attributes: ['id', 'logchannel'] });
        if (!event?.logchannel) return false;
        channelId = event.logchannel;

        const channel = await client.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
            logger.warn(`Event log channel ${channelId} for eventId ${eventId} is not a text channel, using global log channel.`);
            return false;
        }

        await channel.send(message);
        return true;
    } catch (error) {
        const code = error?.code ?? error?.status ?? 'unknown';
        logger.warn(`Could not log to event log channel (eventId: ${eventId}, channel: ${channelId}, code: ${code}), using global log channel: ${error?.message ?? error}`);
        return false;
    }
}

async function logActivity(client, message, { eventId } = {}) {
    if (eventId && await sendToEventLog(client, eventId, message)) return;

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
