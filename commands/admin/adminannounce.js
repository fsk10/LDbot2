// commands/admin/adminannounce.js
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ChannelType } = require('discord.js');
const { EventModel } = require('../../models');
const { isAdmin } = require('../../utils/permissions');
const { formatDisplayDate, parseLocalToUTC } = require('../../utils/dateUtils');
const logActivity = require('../../utils/logActivity');
const logger = require('../../utils/logger');
const { enqueueAnnouncementJob } = require('../../scheduler/announcementsCron');
const { getAvailableSeatsForEvent } = require('../../database/operations');

const commandData = new SlashCommandBuilder()
  .setName('adminannounce')
  .setDescription('Announce an event now or schedule an announcement')
  .addStringOption(option =>
    option.setName('event')
      .setDescription('Event to announce')
      .setRequired(true)
      .setAutocomplete(true)
  )
  .addChannelOption(option =>
    option.setName('channel')
      .setDescription('Discord channel to send the announcement to')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(true)
  )
  .addStringOption(option =>
    option.setName('announce_at')
      .setDescription('Optional schedule time (Europe/Stockholm), format YYYY-MM-DD HH:mm; leave empty to post now')
      .setRequired(false)
  )
  .addBooleanOption(option =>
    option.setName('open_on_post')
      .setDescription('Open registration when the announcement posts?')
      .setRequired(false)
  );

async function prepare() {
  return commandData;
}

/**
 * Build & send the announcement post for a given event/channel.
 * Shared by immediate-run and the scheduler.
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
 */
async function runAnnouncementNow(client, { eventId, channelId, openOnPost, actorTag }) {
  const event = await EventModel.findByPk(eventId);
  if (!event) throw new Error('Event not found.');

  // Optionally open registration
  if (openOnPost && !event.regopen) {
    await event.update({ regopen: true });
    // Match your house style (“Registration Status: Open”)
    logActivity(client,
      `Event **${event.name}** was **updated** by [ **${actorTag || 'Scheduler'}** ]\n` +
      `:white_small_square: **Registration Status**: Open`
    );
  }

  await postAnnouncementForJob(client, event, channelId);

  // Activity log for the announcement itself
  logActivity(client, `Event **${event.name}** announced in <#${channelId}> by **${actorTag || 'Scheduler'}**`);
}

async function execute(interaction) {
  try {
    if (!(await isAdmin(interaction))) {
      const permissionErrorEmbed = new EmbedBuilder()
        .setTitle('Permission Denied')
        .setDescription("You don't have the required permissions to use this command.")
        .setColor('#FF0000');
      return interaction.reply({ embeds: [permissionErrorEmbed], ephemeral: true });
    }

    const eventIdStr = interaction.options.getString('event', true);
    const targetChan = interaction.options.getChannel('channel', true);
    const announceAt = interaction.options.getString('announce_at'); // optional
    const openOnPost = interaction.options.getBoolean('open_on_post') ?? false;

    if (!targetChan || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(targetChan.type)) {
      return interaction.reply({ content: 'Please pick a text or announcement channel.', ephemeral: true });
    }

    const event = await EventModel.findByPk(eventIdStr);
    if (!event) {
      return interaction.reply({ content: 'That event no longer exists.', ephemeral: true });
    }

    // No schedule → post now
    if (!announceAt) {
      await interaction.deferReply({ ephemeral: true });

      await runAnnouncementNow(interaction.client, {
        eventId: event.id,
        channelId: targetChan.id,
        openOnPost,
        actorTag: interaction.user.tag
      });

      await interaction.editReply(`✅ Announced **${event.name}** in ${targetChan}.`);
      return;
    }

    // Parse Stockholm local time -> UTC date
    const atUTCdate = parseLocalToUTC(announceAt);
    if (!atUTCdate) {
      return interaction.reply({
        content: 'Invalid date-time. Use **YYYY-MM-DD HH:mm** (Europe/Stockholm).',
        ephemeral: true
      });
    }

    // Past or now → run immediately
    if (atUTCdate.getTime() <= Date.now()) {
      await interaction.deferReply({ ephemeral: true });

      await runAnnouncementNow(interaction.client, {
        eventId: event.id,
        channelId: targetChan.id,
        openOnPost,
        actorTag: interaction.user.tag
      });

      await interaction.editReply(`✅ Announced **${event.name}** in ${targetChan}.`);
      return;
    }

    // Enqueue one-time job
    const ok = await enqueueAnnouncementJob({
      eventId: event.id,
      channelId: targetChan.id,
      announceAtDate: atUTCdate,
      openOnPost,
      requestedBy: interaction.user.tag
    });

    if (!ok) {
      return interaction.reply({ content: '❌ Failed to schedule announcement.', ephemeral: true });
    }

    const localPretty = formatDisplayDate(atUTCdate); // shows CET/CEST
    await interaction.reply({
      content: `🗓️ Scheduled announcement for **${event.name}** in ${targetChan} at **${localPretty}**.`,
      ephemeral: true
    });

  } catch (error) {
    logger.error(`Error executing adminannounce: ${error.stack || error}`);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'An error occurred while sending/scheduling the announcement.', ephemeral: true });
    } else {
      interaction.editReply({ content: 'An error occurred while sending/scheduling the announcement.' });
    }
  }
}

module.exports = {
  data: commandData,
  execute,
  prepare,
  postAnnouncementForJob,
  runAnnouncementNow,
};
