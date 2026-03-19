const { SlashCommandBuilder, AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { isAdmin } = require('../../utils/permissions');
const config = require('../../config/charts.config.json');
const logger = require('../../utils/logger');
const logActivity = require('../../utils/logActivity');
const { ensureDirSync, loadChartById, invalidateChartCache } = require('../../utils/seating');
const { EventModel } = require('../../models');
const operations = require('../../database/operations');
const { scheduleParticipantListUpdate } = require('../../database/operations');
const { formatChartImportLog, formatChartSetLog } = require('../../utils/activityFormat');

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

async function downloadToFile(url, destPath, maxBytes, allowedMime) {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

  const type = res.headers.get('content-type') || '';
  if (allowedMime && allowedMime.length && !allowedMime.some(m => type.includes(m))) {
    throw new Error(`Unsupported content-type "${type}"`);
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) {
    throw new Error(`File too large (${buf.length} bytes)`);
  }

  await fs.writeFile(destPath, buf);
  return destPath;
}

async function fetchText(url, maxBytes) {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) {
    throw new Error(`File too large (${buf.length} bytes)`);
  }
  return buf.toString('utf8');
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
        .setDescription('Import a seating chart (JSON v2 + base image) and attach to an event.')
        .addStringOption(o => o
          .setName('event')
          .setDescription('Event name or id')
          .setRequired(true)
          .setAutocomplete(true))
        .addAttachmentOption(o => o
          .setName('json')
          .setDescription('The chart.json file (v2, must include "chartId")')
          .setRequired(true))
        .addAttachmentOption(o => o
          .setName('image')
          .setDescription('Base image (png/jpg/webp)')
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
        const jsonAtt = interaction.options.getAttachment('json', true);
        const imgAtt  = interaction.options.getAttachment('image', true);

        await interaction.deferReply({ ephemeral: true });

        const event = await resolveEventByInput(eventInput);
        if (!event) return interaction.editReply(`❌ Event "${eventInput}" not found.`);

        const jsonText = await fetchText(jsonAtt.url, config.uploads?.maxJsonBytes || 1048576);
        let parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch (e) {
          return interaction.editReply(`❌ Uploaded JSON is not valid: ${e.message}`);
        }

        if (parsed.version !== 2) {
          return interaction.editReply(`❌ chart.version must be 2. Received: ${parsed.version ?? '(missing)'}`);
        }
        if (!Array.isArray(parsed.seats)) {
          return interaction.editReply(`❌ chart.seats must be an array.`);
        }
        const chartIdRaw = parsed.chartId || parsed.id || '';
        const chartId = String(chartIdRaw).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        if (!chartId) {
          return interaction.editReply(`❌ chartId missing in JSON. Please include "chartId" in your export.`);
        }

        const dir = path.join(chartsDir(), chartId);
        ensureDirSync(dir);

        const jsonPath = path.join(dir, 'chart.json');
        await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf8');

        const ext = path.extname(imgAtt.name || '').toLowerCase() || '.png';
        const outName = parsed.image?.path ? path.basename(parsed.image.path) : `SeatingMap${ext}`;
        const imgPath = path.join(dir, outName);

        await downloadToFile(
          imgAtt.url,
          imgPath,
          config.uploads?.maxImageBytes || 5242880,
          (config.uploads?.allowedImageMime || ['image/png', 'image/jpeg', 'image/webp'])
        );

        parsed.image = parsed.image || {};
        parsed.image.path = outName;
        await fs.writeFile(jsonPath, JSON.stringify(parsed, null, 2), 'utf8');

        // ensure fresh render uses new files
        invalidateChartCache(chartId);

        // link event -> chartId
        event.chartId = chartId;
        event.baseImagePath = null;
        await event.save();

        // log (unified)
        logActivity(interaction.client, formatChartImportLog(interaction.user.tag, {
          eventName: event.name,
          eventId: event.id,
          chartId,
          imageName: outName
        }));

        await scheduleParticipantListUpdate(interaction.client, event.id);

        return interaction.editReply('✅ Imported and linked.');
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
          return interaction.editReply(`❌ Cannot load chart "${chartId}": ${e.message}`);
        }

        event.chartId = chartId;
        event.baseImagePath = null;
        await event.save();

        // log (unified)
        logActivity(interaction.client, formatChartSetLog(interaction.user.tag, {
          eventName: event.name,
          eventId: event.id,
          chartId
        }));

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
      logger?.error?.(err);
      const msg = (err && err.message) ? err.message : String(err);
      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(`❌ Error: ${msg}`);
      } else {
        return interaction.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
      }
    }
  }
};
