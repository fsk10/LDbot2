// utils/chartImport.js
// Reads a Seat Chart Editor project zip (<name>.json + chart image, plus a
// .csv and base/ floor plan that are ignored), validates it fully in memory
// and only then writes charts/<chartId>/chart.json + the image.
const path = require('path');
const fs = require('fs').promises;
const yauzl = require('yauzl');
const logger = require('./logger');
const config = require('../config/charts.config.json');
const { ensureDirSync, validateChart, invalidateChartCache } = require('./seating');

const MAX_JSON_BYTES = config.uploads?.maxJsonBytes || 1048576;
const MAX_IMAGE_BYTES = config.uploads?.maxImageBytes || 5242880;

// Message is safe to show the admin; anything else is logged and reported generically.
class ChartImportError extends Error {}

function openZip(buffer) {
  return new Promise((resolve, reject) => {
    // validateEntrySizes makes yauzl fail if an entry inflates past its declared size
    yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: false, validateEntrySizes: true },
      (err, zip) => (err ? reject(err) : resolve(zip)));
  });
}

function listEntries(zip) {
  return new Promise((resolve, reject) => {
    const entries = [];
    zip.on('entry', e => { entries.push(e); zip.readEntry(); });
    zip.on('end', () => resolve(entries));
    zip.on('error', reject);
    zip.readEntry();
  });
}

function readEntry(zip, entry, maxBytes) {
  if (entry.uncompressedSize > maxBytes) {
    throw new ChartImportError(`\`${entry.fileName}\` is too large (max ${Math.floor(maxBytes / 1024)} KB).`);
  }
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      let size = 0;
      stream.on('data', c => {
        size += c.length;
        if (size > maxBytes) stream.destroy(new ChartImportError(`\`${entry.fileName}\` is too large.`));
        else chunks.push(c);
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    });
  });
}

function imageExtension(buf) {
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x89504e47) return '.png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  return null;
}

function sanitizeChartId(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

// Seats are stored as INTEGER in eventUsers, so every id must be a whole number >= 1, and unique.
function validateSeats(chart) {
  try {
    validateChart(chart);
  } catch (e) {
    throw new ChartImportError(`Chart is not valid: ${e.message}.`);
  }
  const seen = new Set();
  const bad = [];
  const dupes = new Set();
  for (const s of chart.seats) {
    const id = String(s.id).trim();
    if (!/^\d+$/.test(id) || Number(id) < 1) { bad.push(id); continue; }
    const key = String(Number(id));
    if (seen.has(key)) dupes.add(key);
    seen.add(key);
  }
  if (bad.length) {
    throw new ChartImportError(`Seat ids must be whole numbers from 1 and up. Invalid: \`${bad.slice(0, 10).join(', ')}\`.`);
  }
  if (dupes.size) {
    throw new ChartImportError(`Seat ids must be unique. Duplicates: \`${[...dupes].slice(0, 10).join(', ')}\`.`);
  }
  if (!chart.seats.length) throw new ChartImportError('Chart has no seats.');
}

/**
 * Validate a project zip and save its chart. Writes nothing unless everything
 * checks out. Returns { chartId, imageName, seatCount, replaced }.
 */
async function importChartZip(buffer) {
  let zip;
  try {
    zip = await openZip(buffer);
  } catch (e) {
    logger.warn(`Chart import: could not open zip: ${e.message}`);
    throw new ChartImportError('Could not read the zip file.');
  }

  try {
    let entries;
    try {
      entries = await listEntries(zip);
    } catch (e) {
      logger.warn(`Chart import: invalid zip entries: ${e.message}`);
      throw new ChartImportError('The zip file is damaged or contains invalid file names.');
    }

    // Only files in the zip root count; base/ and other folders are ignored
    const rootFiles = entries.filter(e => !e.fileName.includes('/') && !e.fileName.includes('\\'));
    const jsonEntries = rootFiles.filter(e => e.fileName.toLowerCase().endsWith('.json'));
    if (jsonEntries.length !== 1) {
      throw new ChartImportError(jsonEntries.length
        ? `The zip must contain exactly one chart .json in its root, found ${jsonEntries.length}.`
        : 'The zip contains no chart .json in its root.');
    }

    let chart;
    try {
      chart = JSON.parse((await readEntry(zip, jsonEntries[0], MAX_JSON_BYTES)).toString('utf8'));
    } catch (e) {
      if (e instanceof ChartImportError) throw e;
      throw new ChartImportError(`\`${jsonEntries[0].fileName}\` is not valid JSON.`);
    }

    if (chart?.version !== 2) throw new ChartImportError('Chart version must be 2.');
    const chartId = sanitizeChartId(chart.chartId || chart.id);
    if (!chartId) throw new ChartImportError('The chart JSON has no `chartId`.');
    validateSeats(chart);

    const wantedImage = chart.image?.path ? path.basename(String(chart.image.path)) : '';
    if (!wantedImage) throw new ChartImportError('The chart JSON has no `image.path`.');
    const imageEntry = rootFiles.find(e => e.fileName === wantedImage);
    if (!imageEntry) throw new ChartImportError(`The image \`${wantedImage}\` named in the chart JSON is missing from the zip.`);

    const imageBuf = await readEntry(zip, imageEntry, MAX_IMAGE_BYTES);
    const ext = imageExtension(imageBuf);
    if (!ext) throw new ChartImportError(`\`${wantedImage}\` is not a PNG or JPEG image.`);

    // Everything is valid: write with our own file names, image first, chart.json last
    const chartsDir = config.chartsDir || './charts';
    const dir = path.join(chartsDir, chartId);
    const replaced = await fs.access(path.join(dir, 'chart.json')).then(() => true, () => false);
    ensureDirSync(dir);

    const imageName = `${chartId}${ext}`;
    chart.image = { ...chart.image, path: imageName };
    await writeAtomic(path.join(dir, imageName), imageBuf);
    await writeAtomic(path.join(dir, 'chart.json'), JSON.stringify(chart, null, 2));
    invalidateChartCache(chartId);

    return { chartId, imageName, seatCount: chart.seats.length, replaced };
  } finally {
    zip.close();
  }
}

async function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

module.exports = { importChartZip, ChartImportError };
