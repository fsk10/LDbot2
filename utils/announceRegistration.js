// utils/announceRegistration.js
// Posts a small public embed when a user registers for or leaves an event.
// Only active when the event has an announcechannel set. Never throws, so a
// failed post can't break the registration itself.
const { EmbedBuilder, ChannelType, escapeMarkdown } = require('discord.js');
const { EventModel } = require('../models');
const logger = require('./logger');

const STYLES = {
    registered: { color: '#2ecc71', text: (nick, event) => `🆕 **${nick}** registered for ${event}` },
    left:       { color: '#e74c3c', text: (nick, event) => `❌ **${nick}** left ${event}` },
};

async function announceRegistration(client, eventId, nickname, action) {
    const style = STYLES[action];
    if (!style || !eventId || !nickname) return;

    let channelId = 'not set';
    try {
        const event = await EventModel.findByPk(eventId, { attributes: ['id', 'name', 'enddate', 'announcechannel'] });
        if (!event?.announcechannel) return;
        if (event.enddate && new Date(event.enddate) < new Date()) return; // ended events stay quiet
        channelId = event.announcechannel;

        const channel = await client.channels.fetch(channelId);
        if (!channel || channel.type !== ChannelType.GuildText) {
            logger.warn(`Announce channel ${channelId} for eventId ${eventId} is not a text channel. Skipping announcement.`);
            return;
        }

        const eventName = escapeMarkdown(String(event.name || 'the event'));
        const embed = new EmbedBuilder()
            .setColor(style.color)
            .setDescription(style.text(escapeMarkdown(String(nickname)), eventName));

        await channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
        const code = error?.code ?? error?.status ?? 'unknown';
        logger.warn(`Announce channel ${channelId} for eventId ${eventId} failed (${error?.message ?? error}, code: ${code}). Skipping announcement.`);
    }
}

module.exports = announceRegistration;
