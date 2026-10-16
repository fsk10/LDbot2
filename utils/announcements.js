// utils/announcements.js
// Builds and posts the signup announcement. Shared by /adminannounce and the
// scheduler, kept here so neither has to require the other.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ChannelType } = require('discord.js');
const { EventModel } = require('../models');
const { formatDisplayDate } = require('./dateUtils');
const logActivity = require('./logActivity');
const { getAvailableSeatsForEvent } = require('../database/operations');

// Readable reason for the admin log; full error stays in the bot log.
function failureReason(err) {
  switch (err?.code) {
    case 50001: return 'the bot has no access to the channel';
    case 50013: return 'the bot is missing permissions in the channel';
    case 10003: return 'the channel no longer exists';
    default: return 'see the bot log for details';
  }
}

/**
 * Build & send the announcement post for a given event/channel.
 */
async function postAnnouncementForJob(client, event, channelId) {
  const channel = await client.channels.fetch(channelId);
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new Error('Target channel not found or not a text/announcement channel.');
  }

  const seatsInfo = await getAvailableSeatsForEvent(event.id);
  if (!seatsInfo?.success) {
    throw new Error(`Could not fetch seat information: ${seatsInfo?.error || 'unknown error'}`);
  }

  const totalSeats = seatsInfo.totalSeats;

  const embed = new EmbedBuilder()
    .setTitle(`Signup for ${event.name}!`)
    .setDescription('Click the button below to register for the event!')
    .setColor('#3498db')
    .addFields(
      { name: '📍 Location', value: event.location || 'TBA', inline: false },
      { name: '** **', value: '** **', inline: false },
      { name: '🗓 Starts', value: formatDisplayDate(event.startdate), inline: true },
      { name: '🗓 Ends', value: formatDisplayDate(event.enddate), inline: true },
      { name: '** **', value: '** **', inline: true },
      { name: '🪑 Max Seats', value: `${totalSeats}`, inline: true },
      { name: '💶 Entry Fee', value: event.entryfee != null ? `**€${event.entryfee}**` : 'TBA', inline: true },
      { name: '** **', value: '** **', inline: true }
    )
    .setFooter({
      text: 'You’ll receive a DM to continue your account and event registration',
    });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`register_event-${event.id}`)
      .setLabel('Register Now')
      .setStyle(1) // Primary
  );

  await channel.send({
    content: '@everyone',
    embeds: [embed],
    components: [row],
  });
}

/**
 * Immediately post (and optionally open registration first).
 * A failed post is reported in the log channel and rethrown with
 * err.announceReason (safe to show the admin) and err.regOpened set.
 */
async function runAnnouncementNow(client, { eventId, channelId, openOnPost, actorTag }) {
  const event = await EventModel.findByPk(eventId);
  if (!event) throw new Error('Event not found.');

  // Optionally open registration
  let regOpened = false;
  if (openOnPost && !event.regopen) {
    await event.update({ regopen: true });
    regOpened = true;
    // Match your house style (“Registration Status: Open”)
    logActivity(client,
      `Event **${event.name}** was **updated** by [ **${actorTag || 'Scheduler'}** ]\n` +
      `:white_small_square: **Registration Status**: Open`,
      { eventId: event.id }
    );
  }

  try {
    await postAnnouncementForJob(client, event, channelId);
  } catch (e) {
    const reason = failureReason(e);
    let msg = `❌ Announcement for **${event.name}** in <#${channelId}> by **${actorTag || 'Scheduler'}** **failed**: ${reason}.`;
    if (regOpened) msg += '\nRegistration **was opened** before the post failed.';
    logActivity(client, msg, { eventId: event.id });
    e.announceReason = reason;
    e.regOpened = regOpened;
    throw e;
  }

  // Activity log for the announcement itself
  logActivity(client, `Event **${event.name}** announced in <#${channelId}> by **${actorTag || 'Scheduler'}**`, { eventId: event.id });
}

module.exports = { postAnnouncementForJob, runAnnouncementNow, failureReason };
