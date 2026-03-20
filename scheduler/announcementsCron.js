// scheduler/announcementsCron.js
const { SettingsModel, EventModel } = require('../models');
const { DateTime } = require('luxon');
const crypto = require('crypto');
const logger = require('../utils/logger');
const logActivity = require('../utils/logActivity');
const { postAnnouncementForJob } = require('../commands/admin/adminannounce');
const SETTINGS_KEY = 'announce_jobs';

function makeId() {
  return crypto.randomBytes(10).toString('hex'); // small, unique-ish
}

/**
 * Enqueue a single one-time announcement job.
 * announceAtDate is a JS Date in UTC.
 */
async function enqueueAnnouncementJob({ eventId, channelId, announceAtDate, openOnPost = false, requestedBy = 'unknown' }) {
  try {
    const iso = DateTime.fromJSDate(announceAtDate, { zone: 'utc' }).toISO();
    let row = await SettingsModel.findOne({ where: { key: SETTINGS_KEY } });

    if (!row) {
      row = await SettingsModel.create({
        key: SETTINGS_KEY,
        value: JSON.stringify([]),
        description: 'Scheduled announcement jobs',
      });
    }

    let jobs = [];
    try {
      jobs = JSON.parse(row.value || '[]');
      if (!Array.isArray(jobs)) jobs = [];
    } catch {
      jobs = [];
    }

    const job = {
      id: makeId(),
      eventId,
      channelId,
      announceAtISO: iso,      // UTC time
      openOnPost: !!openOnPost,
      requestedBy,
      status: 'pending',
      attempts: 0,
      postedAtISO: null
    };

    jobs.push(job);
    await row.update({ value: JSON.stringify(jobs) });
    return true;
  } catch (e) {
    logger.error(`[announce-jobs] enqueue failed: ${e.stack || e}`);
    return false;
  }
}

// Run every minute from app.js. Fires due jobs and prunes completed ones.
async function tickAnnounceJobs(client) {
  try {
    const row = await SettingsModel.findOne({ where: { key: SETTINGS_KEY } });
    if (!row) return;

    let jobs = [];
    try {
      const raw = row.value || '[]';
      const parsed = JSON.parse(raw);
      jobs = Array.isArray(parsed) ? parsed : [];
    } catch {
      logger.error('[announce-jobs] settings value is not valid JSON');
      return;
    }

    const nowUtc = DateTime.utc();
    const graceMin = 2; // minutes of LATE tolerance (never early)
    let mutated = false;

    for (const job of jobs) {
      try {
        if (job.status !== 'pending') continue;

        const due = DateTime.fromISO(job.announceAtISO, { zone: 'utc' });
        if (!due.isValid) {
          logger.warn(`[announce-jobs] Skipping job ${job.id}: invalid date ${job.announceAtISO}`);
          job.status = 'failed';
          job.attempts = (job.attempts || 0) + 1;
          mutated = true;
          continue;
        }

        // Only fire at/after due time, with up to N minutes late grace
        const minutesLate = nowUtc.diff(due, 'minutes').minutes;
        if (minutesLate >= 0 && minutesLate <= graceMin) {
          logger.info(`[announce-jobs] Firing job ${job.id} (due ${due.toISO()})`);

          const event = await EventModel.findByPk(job.eventId);
          if (!event) {
            logger.warn(`[announce-jobs] Event ${job.eventId} not found for job ${job.id}`);
            job.status = 'failed';
            job.attempts = (job.attempts || 0) + 1;
            mutated = true;
            continue;
          }

          // Optionally open registration
          if (job.openOnPost && !event.regopen) {
            await event.update({ regopen: true });
            logActivity(
              client,
              `Event **${event.name}** was updated by [ **Scheduler** ]\n:white_small_square: **Registration Status**: Open`
            );
          }

          // Post the announcement (uses your helper exported from adminannounce)
          try {
            await postAnnouncementForJob(client, event, job.channelId);
          } catch (e) {
            logger.error(`[announce-jobs] Post failed for job ${job.id}: ${e.message}`);
            job.status = 'failed';
            job.attempts = (job.attempts || 0) + 1;
            mutated = true;
            continue;
          }

          // Mark as sent
          job.status = 'sent';
          job.postedAtISO = nowUtc.toISO();
          job.attempts = (job.attempts || 0) + 1;
          mutated = true;
        }
      } catch (e) {
        logger.error(`[announce-jobs] Error in job loop: ${e.stack || e}`);
      }
    }

    // Auto-remove completed/failed jobs, keep only pending
    const newJobs = jobs.filter(j => j.status === 'pending');
    if (mutated || newJobs.length !== jobs.length) {
      await row.update({ value: JSON.stringify(newJobs) });
    }
  } catch (e) {
    logger.error(`[announce-jobs] tick failed: ${e.stack || e}`);
  }
}

module.exports = {
  enqueueAnnouncementJob,
  tickAnnounceJobs,
};
