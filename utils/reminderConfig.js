// utils/reminderConfig.js
// Payment reminder texts + channel from config/reminderConfig.json (own copy
// per server, gitignored; template in reminderConfig.example.json). Read once
// at startup: edit the file and restart the bot to change it.
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const FILE = path.join(__dirname, '..', 'config', 'reminderConfig.json');
const REQUIRED = {
  channel: ['title', 'line', 'overdueLine', 'footer'],
  dm: ['text', 'overdueText'],
};

function load() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch {
    logger.warn('Payment reminders: config/reminderConfig.json not found, reminders are off. Copy reminderConfig.example.json to create it.');
    return null;
  }

  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    logger.warn(`Payment reminders: config/reminderConfig.json is not valid JSON (${e.message}), reminders are off.`);
    return null;
  }

  const problems = [];
  if (!/^\d{17,20}$/.test(String(cfg?.channelId || ''))) problems.push('channelId');
  for (const [section, keys] of Object.entries(REQUIRED)) {
    for (const key of keys) {
      if (typeof cfg?.[section]?.[key] !== 'string' || !cfg[section][key].trim()) problems.push(`${section}.${key}`);
    }
  }
  if (problems.length) {
    logger.warn(`Payment reminders: config/reminderConfig.json is missing or has invalid ${problems.join(', ')}; reminders are off.`);
    return null;
  }
  return cfg;
}

const config = load();

// Returns the validated config, or null when reminders are not configured.
function getReminderConfig() {
  return config;
}

// Fills {placeholders}; unknown ones are left as they are.
function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));
}

module.exports = { getReminderConfig, fillTemplate };
