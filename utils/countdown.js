const { DateTime, Settings } = require('luxon');
const fs = require('fs');
const path = require('path');
const { EventModel } = require('../models');
const { Op } = require('sequelize');
const { sequelize } = require('../database/database');
let countdownConfig = require('../config/countdownConfig.js');
const { Client } = require('discord.js');
const logger = require('./logger');

Settings.defaultZoneName = 'Europe/Stockholm';

async function updateCountdownChannel(client) {
  countdownConfig = reloadConfig();
  if (!countdownConfig.isEnabled || !countdownConfig.channel) return { code: 'disabled' };

  const startDate = DateTime.now();
  const endDate = countdownConfig.manualEndDate
    ? DateTime.fromISO(countdownConfig.manualEndDate)
    : await getNextUpcomingEventStartTime();

  logger.info(`Current time: ${startDate.toISO()}`);
  logger.info(`Manual end date: ${countdownConfig.manualEndDate || 'None'}`);
  logger.info(`Closest upcoming event start: ${endDate ? endDate.toISO() : 'None'}`);

  if (!endDate || endDate <= startDate) {
    return await setChannelName(client, countdownConfig.channel, 'No upcoming events');
  }

  const totalDuration = endDate.diff(startDate, ['years','months','days','hours','minutes']);
  const timeRemaining = {
    years: totalDuration.years,
    months: totalDuration.months,
    days: totalDuration.days,
    hours: totalDuration.hours % 24,
    minutes: totalDuration.minutes % 60,
  };

  const channelName = formatTimeRemainingForChannel(timeRemaining);
  logger.info(`Updating channel name to: ${channelName}`);
  return await setChannelName(client, countdownConfig.channel, channelName);
}


let timeoutHandler;

async function scheduleCountdownUpdate(client) {
  // Always reload first
  countdownConfig = reloadConfig();

  if (!countdownConfig.isEnabled || !countdownConfig.channel) {
    logger.info('Countdown updates are disabled or no channel is set.');
    if (timeoutHandler) clearTimeout(timeoutHandler);
    return;
  }

  // Find next event START as before
  const nextEventStart = await getNextUpcomingEventStartTime();

  const now = DateTime.now().setZone('Europe/Stockholm');

  // Default: if we have no events, check again later anyway (don’t stop)
  let delayEventBased;
  if (!nextEventStart) {
    logger.info('No upcoming events found.');
    // set channel to "No upcoming events" (non-blocking rename already handled inside updateCountdownChannel)
    await setChannelName(client, countdownConfig.channel, 'No upcoming events');

    // Try again in 1 hour by default (will be shortened by cooldown logic below if needed)
    delayEventBased = 60 * 60 * 1000;
  } else {
    const timeUntilEvent = nextEventStart.diff(now, ['days']).toObject();
    if ((timeUntilEvent.days || 0) > 30) {
      delayEventBased = calculateDelayForDailyUpdate(now, nextEventStart);
    } else if ((timeUntilEvent.days || 0) >= 1) {
      delayEventBased = calculateDelayForHourlyUpdate(now);
    } else {
      delayEventBased = calculateDelayForTenMinuteUpdate(now);
    }
  }

  // NEW: also consider the rename cooldown so we wake up when it ends
  const cooldownRemaining = getRenameCooldownRemainingMs();

  // If cooldown is active, schedule the next run at the sooner of:
  //  - the event-based delay
  //  - the cooldown ending (plus a tiny buffer)
  const bufferMs = 2000;
  let delayUntilNextUpdate = delayEventBased;
  if (cooldownRemaining > 0) {
    delayUntilNextUpdate = Math.min(delayEventBased, cooldownRemaining + bufferMs);
  }

  // Safety floor/ceiling (optional)
  delayUntilNextUpdate = Math.max(5_000, delayUntilNextUpdate); // at least 5s

  if (timeoutHandler) clearTimeout(timeoutHandler);
  timeoutHandler = setTimeout(() => {
    updateCountdownChannel(client).then(() => scheduleCountdownUpdate(client));
  }, delayUntilNextUpdate);

  logger.info(`Next countdown update scheduled in ${delayUntilNextUpdate} milliseconds.`);
}


/**
 * Returns the DateTime of the next upcoming event START (startdate > now).
 * If none exists, returns null.
 */
async function getNextUpcomingEventStartTime() {
  try {
    const now = new Date();
    logger.info('Fetching the closest event that STARTS after:', now);

    const event = await EventModel.findOne({
      where: {
        startdate: { [Op.gt]: now }, // strictly in the future
      },
      order: [['startdate', 'ASC']],
    });

    if (event) {
      logger.info('Next upcoming event found:', { id: event.id, name: event.name, start: event.startdate, end: event.enddate });
      // Countdown target is the START of the next event
      return DateTime.fromJSDate(event.startdate);
    } else {
      logger.info('No upcoming events found.');
      return null;
    }
  } catch (error) {
    logger.error('Error fetching next upcoming event start time:', error);
    return null;
  }
}

/**
 * If you ever want countdown to the END of a currently active event instead,
 * use this helper and swap calls where appropriate.
 */
async function getActiveEventEndTime() {
  try {
    const now = new Date();
    logger.info('Fetching the closest event that is ACTIVE at:', now);

    const event = await EventModel.findOne({
      where: {
        startdate: { [Op.lte]: now },
        enddate: { [Op.gt]: now },
      },
      order: [['startdate', 'ASC']],
    });

    if (event) {
      logger.info('Active event found:', { id: event.id, name: event.name, start: event.startdate, end: event.enddate });
      return DateTime.fromJSDate(event.enddate);
    } else {
      logger.info('No active events found.');
      return null;
    }
  } catch (error) {
    logger.error('Error fetching active event end time:', error);
    return null;
  }
}

function calculateDelayForDailyUpdate(now, nextEventStart) {
  let nextUpdate = now.set({ hour: nextEventStart.hour, minute: 0, second: 0, millisecond: 0 });
  if (now > nextUpdate) nextUpdate = nextUpdate.plus({ days: 1 });
  return nextUpdate.diff(now, 'milliseconds').milliseconds;
}

function calculateDelayForHourlyUpdate(now) {
  const nextUpdate = now.plus({ hours: 1 }).startOf('hour');
  return nextUpdate.diff(now, 'milliseconds').milliseconds;
}

function calculateDelayForTenMinuteUpdate(now) {
  const minutesToAdd = 10 - (now.minute % 10);
  const nextUpdate = now.plus({ minutes: minutesToAdd });
  return nextUpdate.diff(now, 'milliseconds').milliseconds;
}

// Simple in-memory cooldown shared across calls to avoid hammering Discord
let renameCooldownUntil = 0;
function getRenameCooldownRemainingMs() {
  return Math.max(0, renameCooldownUntil - Date.now());
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function setChannelName(client, channelId, name, { timeoutMs = 3000 } = {}) {
  logger.info('Fetching channel...');
  try {
    const nowMs = Date.now();
    if (renameCooldownUntil && nowMs < renameCooldownUntil) {
      const retryMs = renameCooldownUntil - nowMs;
      logger.info(`Rename on cooldown for ${retryMs} ms; skipping rename to '${name}'.`);
      return { code: 'cooldown', retryMs };
    }

    const channel = await client.channels.fetch(channelId);
    logger.info('Channel fetched:', channel?.name || '(unknown)');
    if (!channel) {
      logger.error('Channel not found.');
      return { code: 'error', details: 'Channel not found' };
    }

    if (channel.name === name) {
      logger.info('Channel name is already up to date.');
      return { code: 'nochange' };
    }

    logger.info(`Updating channel name from '${channel.name}' to '${name}'`);

    const renamePromise = channel.setName(name);
    const timedOut = await Promise.race([
      renamePromise.then(() => false),
      sleep(timeoutMs).then(() => true),
    ]);

    if (timedOut) {
      const backoffMs = 10 * 60 * 1000; // 10 minutes
      renameCooldownUntil = Date.now() + backoffMs;
      logger.warn(`Rename timed out after ${timeoutMs} ms. Backing off for ${backoffMs} ms.`);
      return { code: 'timeout', retryMs: backoffMs };
    }

    logger.info('Channel name updated successfully.');
    return { code: 'updated' };

  } catch (error) {
    const status = error?.status ?? error?.httpStatus ?? error?.code;
    const retryAfterSec = error?.retry_after ?? error?.data?.retry_after;

    if (status === 429) {
      const ms = Math.max((retryAfterSec ? Number(retryAfterSec) * 1000 : 10 * 60 * 1000), 60 * 1000);
      renameCooldownUntil = Date.now() + ms;
      logger.warn(`Hit rate limit (429). Backing off for ${ms} ms.`);
      return { code: 'rate_limited', retryMs: ms };
    }
    if (status === 50013) {
      logger.error('Missing permissions to rename channel (50013).');
      return { code: 'missing_perms' };
    }
    logger.error('Failed to set channel name:', error);
    return { code: 'error', details: String(error?.message || error) };
  }
}


function formatTimeRemainingForChannel(timeRemaining) {
  const { years, months, days, hours, minutes } = timeRemaining;

  if (years > 0) return `${years} year${years > 1 ? 's' : ''} ${months} month${months > 1 ? 's' : ''} ${days} day${days > 1 ? 's' : ''}`;
  if (months > 0) return `${months} month${months > 1 ? 's' : ''} ${days} day${days > 1 ? 's' : ''}`;
  if (days > 0) return `${days} day${days > 1 ? 's' : ''} ${hours} hour${hours > 1 ? 's' : ''}`;
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minute${minutes > 1 ? 's' : ''}`;
  return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

function reloadConfig() {
  delete require.cache[require.resolve('../config/countdownConfig.js')];
  return require('../config/countdownConfig.js');
}

module.exports = {
  updateCountdownChannel,
  scheduleCountdownUpdate,
  reloadConfig,
};
