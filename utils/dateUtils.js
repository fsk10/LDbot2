// utils/dateUtils.js
const { DateTime } = require('luxon');
const logger = require('./logger');

const DEFAULT_TZ = 'Europe/Stockholm';

// ---- NEW: parse "YYYY-MM-DD HH:mm" (or ISO) in Stockholm, return JS Date in UTC
function parseLocalToUTC(input, zone = DEFAULT_TZ) {
  const s = String(input ?? '').trim();
  // First try strict "yyyy-MM-dd HH:mm"
  let dt = DateTime.fromFormat(s, 'yyyy-MM-dd HH:mm', { zone });
  // Fallback to ISO (also interpreted in provided zone)
  if (!dt.isValid) dt = DateTime.fromISO(s, { zone });
  if (!dt.isValid) {
    logger.error(`Invalid date input: ${input}`);
    return null;
  }
  return dt.toUTC().toJSDate();
}

// Existing formatter, keep behavior (and CET/CEST suffix)
function formatDisplayDate(dateInput) {
  const dt = DateTime.fromJSDate(new Date(dateInput)).setZone(DEFAULT_TZ);
  if (!dt.isValid) {
    logger.error(`Invalid date input: ${dateInput}`);
    logger.error(`Reason: ${dt.invalidReason} — ${dt.invalidExplanation}`);
    return 'Invalid DateTime';
  }
  const abbr = dt.isInDST ? 'CEST' : 'CET';
  return `${dt.toFormat('yyyy-MM-dd HH:mm')} ${abbr}`;
}

// Nice discord-localized timestamp helper (optional)
function toDiscordTimestamp(date, style = 'F') {
  const ts = Math.floor(new Date(date).getTime() / 1000);
  return `<t:${ts}:${style}>`;
}

/**
 * IMPORTANT: keep default export compatible with your old `require(...)` usage.
 * This lets `const formatDisplayDate = require('./dateUtils')` still work,
 * while also allowing named imports.
 */
module.exports = Object.assign(formatDisplayDate, {
  formatDisplayDate,
  parseLocalToUTC,
  toDiscordTimestamp,
});
