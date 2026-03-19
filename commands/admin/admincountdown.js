const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ChannelType } = require('discord.js');
const { isAdmin } = require('../../utils/permissions');
const { updateCountdownChannel, scheduleCountdownUpdate, reloadConfig } = require('../../utils/countdown');
const { DateTime } = require('luxon');
const fs = require('fs');
const path = require('path');
const logger = require('../../utils/logger');
const logActivity = require('../../utils/logActivity');

const countdownConfigPath = path.join(__dirname, '../../config/countdownConfig.js');
let countdownConfig = require(countdownConfigPath);

const commandData = new SlashCommandBuilder()
  .setName('admincountdown')
  .setDescription('Manage countdown settings.')
  .addSubcommand(sub =>
    sub.setName('enable')
      .setDescription('Enable the countdown feature.'))
  .addSubcommand(sub =>
    sub.setName('disable')
      .setDescription('Disable the countdown feature.'))
  .addSubcommand(sub =>
    sub.setName('channel')
      .setDescription('Set the countdown channel.')
      .addChannelOption(opt =>
        opt.setName('channel')
          .setDescription('The channel to use for the countdown')
          .addChannelTypes(
            ChannelType.GuildText,
            ChannelType.GuildVoice,
            ChannelType.GuildAnnouncement
          )
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('enddate')
      .setDescription('Set or clear the manual end date for the countdown.')
      .addStringOption(opt =>
        opt.setName('datetime')
          .setDescription('End date (Europe/Stockholm): yyyy-MM-dd HH:mm (omit to clear manual date)')
          .setRequired(false)
      )
  )
  .addSubcommand(sub =>
    sub.setName('useevent')
      .setDescription("Use the closest event's start time as the countdown target.")
      .addBooleanOption(opt =>
        opt.setName('value')
          .setDescription('True = use closest event; False = use manual date (if set)')
          .setRequired(true)
      )
  )
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Show the current countdown configuration.')
  )
  .addSubcommand(sub =>
    sub.setName('update')
      .setDescription('Immediately update the countdown channel name.')
  );

function humanizeRenameStatus(status) {
  if (!status || !status.code) return '';
  switch (status.code) {
    case 'updated':
      return '✅ Channel name updated.';
    case 'nochange':
      return 'ℹ️ Channel name already up to date.';
    case 'cooldown':
      return `⏳ Rename skipped due to cooldown. Will retry in ~${Math.ceil((status.retryMs || 0) / 60000)} min.`;
    case 'timeout':
      return `⏳ Rename deferred (timeout). Will retry in ~${Math.ceil((status.retryMs || 0) / 60000)} min.`;
    case 'rate_limited':
      return `🚦 Rate-limited by Discord. Will retry in ~${Math.ceil((status.retryMs || 0) / 60000)} min.`;
    case 'missing_perms':
      return '❌ Missing **Manage Channels** permission for that channel.';
    case 'disabled':
      return '⚙️ Countdown is disabled or channel not set.';
    case 'error':
      return `⚠️ Failed to rename: ${status.details || 'Unknown error'}`;
    default:
      return '';
  }
}

async function execute(interaction, client) {
  // Permission gate
  const userIsAdmin = await isAdmin(interaction);
  if (!userIsAdmin) {
    const permissionErrorEmbed = new EmbedBuilder()
      .setTitle('Permission Denied')
      .setDescription("You don't have the required permissions to use this command.")
      .setColor('#FF0000');
    return interaction.reply({ embeds: [permissionErrorEmbed], ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  // Always reload the config at the start of each run
  countdownConfig = reloadConfig();

  const subcommand = interaction.options.getSubcommand();
  let replyMessage = '';

  try {
    switch (subcommand) {
      case 'enable': {
        countdownConfig.isEnabled = true;
        saveCountdownConfig(countdownConfig);
        const status = await updateCountdownChannel(client);
        await scheduleCountdownUpdate(client);
        replyMessage = 'Countdown feature has been **enabled**.';
        const note = humanizeRenameStatus(status);
        if (note) replyMessage += `\n\n${note}`;
        logActivity(client, `Countdown has been **Enabled** by [ **${interaction.user.tag}** ]`);
        break;
      }

      case 'disable': {
        countdownConfig.isEnabled = false;
        saveCountdownConfig(countdownConfig);
        await scheduleCountdownUpdate(client); // cancels/adjusts timer, sets "No upcoming events"
        replyMessage = 'Countdown feature has been **disabled**.';
        // No rename attempted here; nothing to append.
        logActivity(client, `Countdown has been **Disabled** by [ **${interaction.user.tag}** ]`);
        break;
      }

      case 'channel': {
        const channel = interaction.options.getChannel('channel');
        if (!channel) {
          replyMessage = 'Could not resolve that channel.';
          break;
        }
        countdownConfig.channel = channel.id;
        saveCountdownConfig(countdownConfig);
        const status = await updateCountdownChannel(client);
        await scheduleCountdownUpdate(client);
        replyMessage = `Countdown channel set to <#${countdownConfig.channel}>.`;
        const note = humanizeRenameStatus(status);
        if (note) replyMessage += `\n\n${note}`;
        logActivity(client, `Countdown channel changed to **${channel.name} (ID: ${channel.id})** by [**${interaction.user.tag}**]`);
        break;
      }

      case 'enddate': {
        const datetimeString = interaction.options.getString('datetime');

        if (!datetimeString) {
          // Clear manual date
          countdownConfig.manualEndDate = null;
          saveCountdownConfig(countdownConfig);
          const status = await updateCountdownChannel(client);
          await scheduleCountdownUpdate(client);
          replyMessage = 'Manual end date has been **cleared**.';
          const note = humanizeRenameStatus(status);
          if (note) replyMessage += `\n\n${note}`;
          logActivity(client, `Manual end date **cleared** by [**${interaction.user.tag}**]`);
          break;
        }

        const dt = DateTime.fromFormat(datetimeString, 'yyyy-MM-dd HH:mm', { zone: 'Europe/Stockholm' });
        if (!dt.isValid) {
          replyMessage = 'Invalid date. Use format **YYYY-MM-DD HH:MM** (Europe/Stockholm).';
          break;
        }

        countdownConfig.manualEndDate = dt.toISO();
        // Do NOT flip useClosestEvent here; that’s controlled via /admincountdown useevent
        saveCountdownConfig(countdownConfig);
        const status = await updateCountdownChannel(client);
        await scheduleCountdownUpdate(client);
        replyMessage = `Manual end date set to **${dt.toFormat('yyyy-MM-dd HH:mm')}**.`;
        const note = humanizeRenameStatus(status);
        if (note) replyMessage += `\n\n${note}`;
        logActivity(client, `Manual end date set to **${dt.toFormat('yyyy-MM-dd HH:mm')}** by [**${interaction.user.tag}**]`);
        break;
      }

      case 'useevent': {
        const useClosest = interaction.options.getBoolean('value');
        countdownConfig.useClosestEvent = useClosest;
        if (useClosest) {
          // When switching to event-based, clear manual override to avoid confusion
          countdownConfig.manualEndDate = null;
        }
        saveCountdownConfig(countdownConfig);
        const status = await updateCountdownChannel(client);
        await scheduleCountdownUpdate(client);

        replyMessage = useClosest
          ? "Countdown is now set to **use the closest event's start time**."
          : 'Countdown is now set to **use a manually set end date** (if configured).';
        const note = humanizeRenameStatus(status);
        if (note) replyMessage += `\n\n${note}`;

        logActivity(
          client,
          `Countdown configured to **${useClosest ? "Closest Event Start-Date" : "Manual Date"}** by [**${interaction.user.tag}**]`
        );
        break;
      }

      case 'status': {
        countdownConfig = reloadConfig();

        let channelInfo = 'Not Set';
        if (countdownConfig.channel) {
          try {
            const channel = await client.channels.fetch(countdownConfig.channel);
            channelInfo = channel ? `${channel.name} (ID: ${channel.id})` : `Unknown (ID: ${countdownConfig.channel})`;
          } catch {
            channelInfo = `Failed to fetch channel for ID: ${countdownConfig.channel}`;
          }
        }

        let endDateFormatted = 'Not Set';
        if (countdownConfig.manualEndDate) {
          const endDate = DateTime.fromISO(countdownConfig.manualEndDate, { zone: 'Europe/Stockholm' });
          endDateFormatted = endDate.isValid ? endDate.toFormat('yyyy-MM-dd HH:mm') : '(invalid date in config)';
        }

        const usingClosestEventStatus = countdownConfig.useClosestEvent ? 'Yes' : 'No';

        const statusEmbed = new EmbedBuilder()
          .setTitle('Countdown Configuration Status')
          .setColor('#0099ff')
          .addFields(
            { name: 'Countdown Enabled', value: countdownConfig.isEnabled ? 'Yes' : 'No', inline: true },
            { name: 'Countdown Channel', value: channelInfo, inline: false },
            { name: 'Manual End Date', value: endDateFormatted, inline: true },
            { name: 'Using Closest Event', value: usingClosestEventStatus, inline: true }
          );

        await interaction.editReply({ embeds: [statusEmbed], ephemeral: true });
        return; // already replied
      }

      case 'update': {
        const status = await updateCountdownChannel(client);
        await scheduleCountdownUpdate(client);
        replyMessage = 'Countdown channel has been **updated**.';
        const note = humanizeRenameStatus(status);
        if (note) replyMessage += `\n\n${note}`;
        break;
      }

      default:
        replyMessage = 'Unknown subcommand.';
        break;
    }
  } catch (err) {
    logger?.error?.(`admincountdown error (${subcommand}): ${err?.message || err}`);
    replyMessage = 'Settings saved, but updating/scheduling failed. Check logs.';
  }

  // Unified reply for all non-status subcommands
  const embed = new EmbedBuilder()
    .setTitle('Countdown Configuration')
    .setDescription(replyMessage.trim())
    .setColor('#0099ff');

  await interaction.editReply({ embeds: [embed], ephemeral: true });
}

function saveCountdownConfig(config) {
  // Persist as CommonJS module so reloadConfig() works
  fs.writeFileSync(countdownConfigPath, `module.exports = ${JSON.stringify(config, null, 4)};`);
}

module.exports = {
  data: commandData.toJSON(),
  execute,
};
