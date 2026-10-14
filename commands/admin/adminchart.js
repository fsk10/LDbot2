const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const path = require('path');
const fsSync = require('fs');
const { isAdmin } = require('../../utils/permissions');
const config = require('../../config/charts.config.json');
const logger = require('../../utils/logger');
const logActivity = require('../../utils/logActivity');
const { ensureDirSync, loadChartById } = require('../../utils/seating');
const { EventModel } = require('../../models');
const operations = require('../../database/operations');
const { scheduleParticipantListUpdate } = require('../../database/operations');
const { formatChartImportLog, formatChartSetLog } = require('../../utils/activityFormat');
const { importChartZip, ChartImportError } = require('../../utils/chartImport');
const { Op } = require('sequelize');

function chartsDir() {
  const dir = config.chartsDir || './charts';
  ensureDirSync(dir);
  return dir;
}

async function resolveEventByInput(input) {
  const v = String(input || '').trim();
  if (/^\d+$/.test(v)) {
    const byId = await EventModel.findByPk(Number(v));
    if (byId) return byId;
  }
  return EventModel.findOne({ where: { name: v } });
}

async function downloadBuffer(url, maxBytes) {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new ChartImportError('The zip file is too large.');
  return buf;
}

function listChartIdsLocal(query) {
  const dir = chartsDir();
  let ids = new Set();

  if (fsSync.existsSync(dir)) {
    const entries = fsSync.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) {
        const fp = path.join(dir, e.name, 'chart.json');
        if (fsSync.existsSync(fp)) ids.add(e.name);
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
        ids.add(path.basename(e.name, '.json'));
      }
    }
  }

  let arr = [...ids];
  if (query) {
    const q = query.toLowerCase();
    arr = arr.filter(id => id.toLowerCase().includes(q));
  }
  return arr.sort().slice(0, 25).map(id => ({ name: id, value: id }));
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('adminchart')
    .setDescription('Manage per-event seating charts.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

    .addSubcommand(sub =>
      sub.setName('import')
        .setDescription('Import a Seat Chart Editor project zip and attach it to an event.')
        .addStringOption(o => o
          .setName('event')
          .setDescription('Event name or id')
          .setRequired(true)
          .setAutocomplete(true))
        .addAttachmentOption(o => o
          .setName('zip')
          .setDescription('Project zip from Seat Chart Editor (chart .json + chart image)')
          .setRequired(true))
    )

    .addSubcommand(sub =>
      sub.setName('set')
        .setDescription('Attach an existing chart to an event.')
        .addStringOption(o => o
          .setName('event')
          .setDescription('Event name or id')
          .setRequired(true)
          .setAutocomplete(true))
        .addStringOption(o => o
          .setName('chart_id')
          .setDescription('Existing chartId')
          .setRequired(true)
          .setAutocomplete(true))
    )

    .addSubcommand(sub =>
      sub.setName('preview')
        .setDescription('Render current seating map for an event.')
        .addStringOption(o => o
          .setName('event')
          .setDescription('Event name or id')
          .setRequired(true)
          .setAutocomplete(true))
    )

    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('List uploaded chartIds.')
    ),

  async execute(interaction) {
    if (!(await isAdmin(interaction))) {
      return interaction.reply({ content: '❌ You don’t have permission to use this command.', ephemeral: true });
    }

    try {
      const sub = interaction.options.getSubcommand();

      if (sub === 'import') {
        const eventInput = interaction.options.getString('event', true);
        const zipAtt = interaction.options.getAttachment('zip', true);

        await interaction.deferReply({ ephemeral: true });

        const event = await resolveEventByInput(eventInput);
        if (!event) return interaction.editReply(`❌ Event "${eventInput}" not found.`);

        const maxZip = config.uploads?.maxZipBytes || 26214400;
        if (!/\.zip$/i.test(zipAtt.name || '') || zipAtt.size > maxZip) {
          return interaction.editReply(`❌ Please attach the project **.zip** from Seat Chart Editor (max ${Math.floor(maxZip / 1048576)} MB).`);
        }

        // Validates everything before writing; nothing is saved on a ChartImportError
        let result;
        try {
          result = await importChartZip(await downloadBuffer(zipAtt.url, maxZip));
        } catch (e) {
          if (e instanceof ChartImportError) return interaction.editReply(`❌ ${e.message} Nothing was imported.`);
          throw e;
        }
        const { chartId, imageName, seatCount, replaced } = result;

        // link event -> chartId
        event.chartId = chartId;
        event.baseImagePath = null;
        await event.save();

        // log (unified)
        logActivity(interaction.client, formatChartImportLog(interaction.user.tag, {
          eventName: event.name,
          eventId: event.id,
          chartId,
          imageName
        }), { eventId: event.id });

        await scheduleParticipantListUpdate(interaction.client, event.id);

        let reply = `✅ Imported chart \`${chartId}\` (${seatCount} seats) and linked it to **${event.name}**.`;
        if (replaced) {
          const others = await EventModel.findAll({ where: { chartId, id: { [Op.ne]: event.id } }, attributes: ['name'] });
          reply += `\n⚠️ This replaced the existing chart \`${chartId}\`` +
            (others.length ? `, which is also used by: ${others.map(o => `**${o.name}**`).join(', ')}.` : '.');
        }
        if (seatCount !== Number(event.seatsavailable || 0)) {
          reply += `\nℹ️ The chart has ${seatCount} seats but the event has seatsavailable = ${event.seatsavailable ?? 'not set'}. Update it with **/adminedit event** if needed.`;
        }
        return interaction.editReply(reply);
      }

      if (sub === 'set') {
        const eventInput = interaction.options.getString('event', true);
        const chartId   = interaction.options.getString('chart_id', true).trim();

        await interaction.deferReply({ ephemeral: true });

        const event = await resolveEventByInput(eventInput);
        if (!event) return interaction.editReply(`❌ Event "${eventInput}" not found.`);

        try {
          await loadChartById(chartId);
        } catch (e) {
          logger.warn(`adminchart set: cannot load chart "${chartId}": ${e.message}`);
          return interaction.editReply(`❌ Cannot load chart "${chartId}". Check the id with **/adminchart list**.`);
        }

        event.chartId = chartId;
        event.baseImagePath = null;
        await event.save();

        // log (unified)
        logActivity(interaction.client, formatChartSetLog(interaction.user.tag, {
          eventName: event.name,
          eventId: event.id,
          chartId
        }), { eventId: event.id });

        await scheduleParticipantListUpdate(interaction.client, event.id);

        return interaction.editReply('✅ Chart set.');
      }

      if (sub === 'preview') {
        const eventInput = interaction.options.getString('event', true);
        await interaction.deferReply({ ephemeral: false });

        const event = await resolveEventByInput(eventInput);
        if (!event) return interaction.editReply(`❌ Event "${eventInput}" not found.`);

        const buffer = await operations.generateCurrentSeatingMap(event.id);
        const file = new AttachmentBuilder(buffer, { name: `SeatingPreview-${event.name}.png` });

        return interaction.editReply({ content: `Seating preview for **${event.name}**`, files: [file] });
      }

      if (sub === 'list') {
        await interaction.deferReply({ ephemeral: true });

        const dir = chartsDir();
        const entries = fsSync.readdirSync(dir, { withFileTypes: true });
        const ids = new Set();

        for (const e of entries) {
          if (e.isDirectory()) {
            const fp = path.join(dir, e.name, 'chart.json');
            if (fsSync.existsSync(fp)) ids.add(e.name);
          } else if (e.isFile() && e.name.toLowerCase().endsWith('.json')) {
            ids.add(path.basename(e.name, '.json'));
          }
        }

        if (!ids.size) return interaction.editReply('No charts uploaded yet.');
        return interaction.editReply(`Available chartIds:\n• ${[...ids].sort().join('\n• ')}`);
      }

      return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    } catch (err) {
      logger.error(`adminchart error: ${err?.stack || err}`);
      const content = '❌ Something went wrong. Details are in the bot log.';
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(content).catch(() => {});
      } else {
        return interaction.reply({ content, ephemeral: true }).catch(() => {});
      }
    }
  }
};
