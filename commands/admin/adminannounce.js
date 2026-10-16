// commands/admin/adminannounce.js
const { SlashCommandBuilder, EmbedBuilder, ChannelType } = require('discord.js');
const { EventModel } = require('../../models');
const { isAdmin } = require('../../utils/permissions');
const { formatDisplayDate, parseLocalToUTC } = require('../../utils/dateUtils');
const logActivity = require('../../utils/logActivity');
const logger = require('../../utils/logger');
const { enqueueAnnouncementJob, listPendingJobs, cancelAnnouncementJob } = require('../../scheduler/announcementsCron');
const { runAnnouncementNow } = require('../../utils/announcements');

const commandData = new SlashCommandBuilder()
  .setName('adminannounce')
  .setDescription('Announce an event now, schedule it, or manage scheduled announcements')
  .addSubcommand(sub =>
    sub.setName('send')
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
      )
  )
  .addSubcommand(sub =>
    sub.setName('list')
      .setDescription('List scheduled announcements that have not been sent yet')
  )
  .addSubcommand(sub =>
    sub.setName('cancel')
      .setDescription('Cancel a scheduled announcement')
      .addStringOption(option =>
        option.setName('job')
          .setDescription('Scheduled announcement to cancel')
          .setRequired(true)
          .setAutocomplete(true)
      )
  );

async function prepare() {
  return commandData;
}

async function eventNames(jobs) {
  const ids = [...new Set(jobs.map(j => j.eventId))];
  const events = ids.length ? await EventModel.findAll({ where: { id: ids }, attributes: ['id', 'name'] }) : [];
  return new Map(events.map(e => [e.id, e.name]));
}

function jobTime(job) {
  return formatDisplayDate(new Date(job.announceAtISO));
}

// Autocomplete for /adminannounce cancel job:<…>
async function handleJobAutocomplete(interaction) {
  if (!(await isAdmin(interaction))) return interaction.respond([]);
  const query = (interaction.options.getFocused() || '').toString().toLowerCase();
  const jobs = await listPendingJobs();
  const names = await eventNames(jobs);
  const choices = jobs
    .map(j => {
      const channel = interaction.guild?.channels.cache.get(j.channelId);
      const label = `${names.get(j.eventId) || `Event ${j.eventId}`} · ${jobTime(j)} · #${channel?.name || j.channelId}`;
      return { name: label.slice(0, 100), value: j.id };
    })
    .filter(c => c.name.toLowerCase().includes(query))
    .slice(0, 25);
  return interaction.respond(choices);
}

async function executeSend(interaction) {
  const eventIdStr = interaction.options.getString('event', true);
  const targetChan = interaction.options.getChannel('channel', true);
  const announceAt = interaction.options.getString('announce_at'); // optional
  const openOnPost = interaction.options.getBoolean('open_on_post') ?? false;

  if (!targetChan || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(targetChan.type)) {
    return interaction.reply({ content: 'Please pick a text or announcement channel.', ephemeral: true });
  }

  const event = /^\d+$/.test(eventIdStr) ? await EventModel.findByPk(Number(eventIdStr)) : null;
  if (!event) {
    return interaction.reply({ content: 'That event no longer exists.', ephemeral: true });
  }

  let atUTCdate = null;
  if (announceAt) {
    // Parse Stockholm local time -> UTC date
    atUTCdate = parseLocalToUTC(announceAt);
    if (!atUTCdate) {
      return interaction.reply({
        content: 'Invalid date-time. Use **YYYY-MM-DD HH:mm** (Europe/Stockholm).',
        ephemeral: true
      });
    }
  }

  // No schedule, or past/now → post now
  if (!atUTCdate || atUTCdate.getTime() <= Date.now()) {
    await interaction.deferReply({ ephemeral: true });

    await runAnnouncementNow(interaction.client, {
      eventId: event.id,
      channelId: targetChan.id,
      openOnPost,
      actorTag: interaction.user.tag
    });

    return interaction.editReply(`✅ Announced **${event.name}** in ${targetChan}.`);
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
  return interaction.reply({
    content: `🗓️ Scheduled announcement for **${event.name}** in ${targetChan} at **${localPretty}**.`,
    ephemeral: true
  });
}

async function executeList(interaction) {
  const jobs = await listPendingJobs();
  if (!jobs.length) {
    return interaction.reply({ content: 'No scheduled announcements.', ephemeral: true });
  }
  const names = await eventNames(jobs);
  const lines = jobs.map(j =>
    `\`${j.id.slice(0, 6)}\` **${names.get(j.eventId) || `Event ${j.eventId} (missing)`}** → <#${j.channelId}> at **${jobTime(j)}**` +
    ` · opens registration: ${j.openOnPost ? 'yes' : 'no'} · by ${j.requestedBy || 'unknown'}`
  );

  let content = `**Scheduled announcements (${jobs.length})**\n${lines.join('\n')}`;
  if (content.length > 2000) content = content.slice(0, 1990) + '\n…';
  return interaction.reply({ content, ephemeral: true });
}

async function executeCancel(interaction) {
  const jobId = interaction.options.getString('job', true).trim();
  if (!/^[0-9a-f]{20}$/.test(jobId)) {
    return interaction.reply({ content: '❌ Pick a scheduled announcement from the list.', ephemeral: true });
  }

  const job = await cancelAnnouncementJob(jobId);
  if (!job) {
    return interaction.reply({ content: '❌ That announcement is no longer scheduled (already sent or cancelled).', ephemeral: true });
  }

  const event = await EventModel.findByPk(job.eventId, { attributes: ['id', 'name'] });
  const name = event ? `**${event.name}**` : `event id ${job.eventId}`;
  logActivity(interaction.client,
    `Scheduled announcement for ${name} in <#${job.channelId}> at **${jobTime(job)}** was **cancelled** by **${interaction.user.tag}**`,
    { eventId: event ? event.id : undefined }
  );

  return interaction.reply({ content: `🗑️ Cancelled the announcement for ${name} at **${jobTime(job)}**.`, ephemeral: true });
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

    const sub = interaction.options.getSubcommand();
    if (sub === 'send') return await executeSend(interaction);
    if (sub === 'list') return await executeList(interaction);
    if (sub === 'cancel') return await executeCancel(interaction);
    return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
  } catch (error) {
    logger.error(`Error executing adminannounce: ${error.stack || error}`);
    const content = '❌ Something went wrong. Details are in the bot log.';
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply({ content }).catch(() => {});
    }
    return interaction.reply({ content, ephemeral: true }).catch(() => {});
  }
}

module.exports = {
  data: commandData,
  execute,
  prepare,
  handleJobAutocomplete,
};
