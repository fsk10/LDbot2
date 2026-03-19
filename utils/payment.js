// utils/payment.js
// Centralized helpers for payment configuration:
// - Global (default) config comes from ../config/paymentConfig.(js|json)
// - Per-event overrides live as JSON files in ../config named: paymentConfig_*.json

const fs = require('fs');
const path = require('path');

// Keep a hot-reloadable handle to the global (default) config.
// This supports either ../config/paymentConfig.js or .json.
let paymentConfig = require('../config/paymentConfig');

/** Hot-reload the global/default paymentConfig (../config/paymentConfig.js or .json). */
function reloadPaymentConfig() {
  try {
    const modPath = require.resolve('../config/paymentConfig');
    delete require.cache[modPath];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    paymentConfig = require('../config/paymentConfig');
  } catch {
    // If reload fails, keep the last in-memory paymentConfig.
  }
  return paymentConfig;
}

/** Build embed fields from a payment config object (methods + optional trailing note). */
function buildPaymentFields(config) {
  const fields = [];

  // Spacer (kept for your embed layout)
  fields.push({ name: '** **', value: '** **' });

  for (const m of (config?.methods || [])) {
    fields.push({
      name: m.type,
      value: m.value,
      inline: Boolean(m.inline),
    });
  }

  // Spacer
  fields.push({ name: '** **', value: '** **' });

  // Trailing note (optional)
  if (config?.notes?.afterList) {
    fields.push({ name: ' ', value: config.notes.afterList });
  }

  return fields;
}

/**
 * Return a sorted array of available per-event config *base names* (no ".json"),
 * e.g. ["paymentConfig_Belgium", "paymentConfig_Sweden"].
 */
function listPaymentConfigFiles() {
  try {
    const cfgDir = path.resolve(__dirname, '../config');
    if (!fs.existsSync(cfgDir)) return [];
    return fs
      .readdirSync(cfgDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^paymentConfig_.*\.json$/i.test(e.name))
      .map((e) => path.basename(e.name, '.json'))
      .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
  } catch {
    return [];
  }
}

/**
 * Load a per-event config by the value stored on the event row: event.paymentconfig.
 * Accepts either "paymentConfig_Sweden" OR "paymentConfig_Sweden.json" (case-insensitive).
 * Falls back to the global/default config on any issue.
 */
function getPaymentConfigForEvent(eventRow) {
  const globalCfg = reloadPaymentConfig();

  const raw = String(eventRow?.paymentconfig || '').trim();
  if (!raw) return globalCfg;

  const base = raw.replace(/\.json$/i, ''); // normalize (strip .json if present)
  const cfgDir = path.resolve(__dirname, '../config');

  // 1) Try exact "<base>.json"
  let full = path.join(cfgDir, `${base}.json`);
  if (fs.existsSync(full)) {
    try {
      return JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      return globalCfg;
    }
  }

  // 2) Case-insensitive match across available files
  const candidates = listPaymentConfigFiles(); // base names without .json
  const match = candidates.find((b) => b.toLowerCase() === base.toLowerCase());
  if (match) {
    full = path.join(cfgDir, `${match}.json`);
    try {
      return JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch {
      return globalCfg;
    }
  }

  // Fallback
  return globalCfg;
}

module.exports = {
  buildPaymentFields,
  reloadPaymentConfig,
  listPaymentConfigFiles,
  getPaymentConfigForEvent,
  loadPaymentConfigForEvent: getPaymentConfigForEvent,
  get paymentConfig() {
    return paymentConfig;
  },
};
