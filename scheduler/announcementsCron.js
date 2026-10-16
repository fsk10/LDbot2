// scheduler/announcementsCron.js
const { SettingsModel, EventModel } = require('../models');
const { DateTime } = require('luxon');
const crypto = require('crypto');
const logger = require('../utils/logger');
const logActivity = require('../utils/logActivity');
const { withEventLock } = require('../utils/eventLock');
const { formatDisplayDate } = require('../utils/dateUtils');
const { postAnnouncementForJob } = require('../utils/announcements');
const SETTINGS_KEY = 'announce_jobs';
const LOCK_KEY = 'announce-jobs';
const GRACE_MIN = 2; // minutes of LATE tolerance (never early); later than this counts as missed

function makeId() {
  return crypto.randomBytes(10).toString('hex'); // small, unique-ish
}

// All reads-modify-writes of the job list go through this lock, so the
// scheduler, /adminannounce send and /adminannounce cancel can't overwrite
// each other's changes.
function withJobsLock(fn) {
  return withEventLock(LOCK_KEY, fn);
}

async function loadJobs() {
  let row = await SettingsModel.findOne({ where: { key: SETTINGS_KEY } });
  let jobs = [];
  if (row) {
    try {
      const parsed = JSON.parse(row.value || '[]');
      jobs = Array.isArray(parsed) ? parsed : [];
    } catch {
      throw new Error('announce_jobs setting is not valid JSON');
    }
  }
  return { row, jobs };
}

async function saveJobs(row, jobs) {
  const value = JSON.stringify(jobs);
  if (row) await row.update({ value });
  else await SettingsModel.create({ key: SETTINGS_KEY, value, description: 'Scheduled announcement jobs' });
}

/**
 * Enqueue a single one-time announcement job.
 * announceAtDate is a JS Date in UTC.
 */
async function enqueueAnnouncementJob({ eventId, channelId, announceAtDate, openOnPost = false, requestedBy = 'unknown' }) {
  try {
    const iso = DateTime.fromJSDate(announceAtDate, { zone: 'utc' }).toISO();
    await withJobsLock(async () => {
      const { row, jobs } = await loadJobs();
      jobs.push({
        id: makeId(),
        eventId,
        channelId,
        announceAtISO: iso,      // UTC time
        openOnPost: !!openOnPost,
        requestedBy,
        status: 'pending',
        attempts: 0,
        postedAtISO: null
      });
      await saveJobs(row, jobs);
    });
    return true;
  } catch (e) {
    logger.error(`[announce-jobs] enqueue failed: ${e.stack || e}`);
    return false;
  }
}

// Pending jobs, soonest first.
async function listPendingJobs() {
  const { jobs } = await loadJobs();
  return jobs
    .filter(j => j.status === 'pending')
    .sort((a, b) => String(a.announceAtISO).localeCompare(String(b.announceAtISO)));
}

// Removes a pending job. Returns the removed job, or null if there was none with that id.
async function cancelAnnouncementJob(jobId) {
  return withJobsLock(async () => {
    const { row, jobs } = await loadJobs();
    const idx = jobs.findIndex(j => j.id === jobId && j.status === 'pending');
    if (idx === -1) return null;
    const [job] = jobs.splice(idx, 1);
    await saveJobs(row, jobs);
    return job;
  });
}

// The job's due time was passed by more than the grace period (bot offline or
// stalled). It is never sent late; admins are told so they can do it by hand.
async function reportMissedJob(client, job, due) {
  const event = await EventModel.findByPk(job.eventId);
  const name = event ? `**${event.name}**` : `event id ${job.eventId} (no longer exists)`;
  let msg = `⚠️ Scheduled announcement for ${name} in <#${job.channelId}> was due at **${formatDisplayDate(due.toJSDate())}** but was **not sent** (the bot was offline).`;
  if (job.openOnPost && event && !event.regopen) {
    msg += '\nRegistration was **not opened** either.';
  }
  msg += '\nPost it manually with **/adminannounce send** if it is still needed.';
  logActivity(client, msg, { eventId: event ? event.id : undefined });
}

// Readable reason for the admin log; full error stays in the bot log.
function failureReason(err) {
  switch (err?.code) {
    case 50001: return 'the bot has no access to the channel';
    case 50013: return 'the bot is missing permissions in the channel';
    case 10003: return 'the channel no longer exists';
    default: return 'see the bot log for details';
  }
}

// The scheduler tried to post but couldn't; tell the admins in the log channel.
function reportFailedJob(client, job, event, reason, regOpened) {
  const name = event ? `**${event.name}**` : `event id ${job.eventId} (no longer exists)`;
  let msg = `❌ Scheduled announcement for ${name} in <#${job.channelId}> at **${formatDisplayDate(new Date(job.announceAtISO))}** **failed**: ${reason}.`;
  if (regOpened) msg += '\nRegistration **was opened** before the post failed.';
  msg += '\nPost it manually with **/adminannounce send**.';
  logActivity(client, msg, { eventId: event ? event.id : undefined });
}

// Run every minute from app.js. Fires due jobs and prunes completed ones.
async function tickAnnounceJobs(client) {
  try {
    await withJobsLock(async () => {
      let row, jobs;
      try {
        ({ row, jobs } = await loadJobs());
      } catch (e) {
        logger.error(`[announce-jobs] ${e.message}`);
        return;
      }
      if (!row) return;

      const nowUtc = DateTime.utc();
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

          const minutesLate = nowUtc.diff(due, 'minutes').minutes;
          if (minutesLate < 0) continue;

          if (minutesLate > GRACE_MIN) {
            logger.warn(`[announce-jobs] Job ${job.id} missed (due ${due.toISO()}, ${Math.round(minutesLate)} min late), not sending`);
            job.status = 'missed';
            mutated = true;
            await reportMissedJob(client, job, due);
            continue;
          }

          logger.info(`[announce-jobs] Firing job ${job.id} (due ${due.toISO()})`);

          const event = await EventModel.findByPk(job.eventId);
          if (!event) {
            logger.warn(`[announce-jobs] Event ${job.eventId} not found for job ${job.id}`);
            reportFailedJob(client, job, null, 'the event no longer exists', false);
            job.status = 'failed';
            job.attempts = (job.attempts || 0) + 1;
            mutated = true;
            continue;
          }

          // Optionally open registration
          let regOpened = false;
          if (job.openOnPost && !event.regopen) {
            await event.update({ regopen: true });
            regOpened = true;
            logActivity(
              client,
              `Event **${event.name}** was updated by [ **Scheduler** ]\n:white_small_square: **Registration Status**: Open`,
              { eventId: event.id }
            );
          }

          try {
            await postAnnouncementForJob(client, event, job.channelId);
          } catch (e) {
            logger.error(`[announce-jobs] Post failed for job ${job.id}: ${e.message}`);
            reportFailedJob(client, job, event, failureReason(e), regOpened);
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
        } catch (e) {
          logger.error(`[announce-jobs] Error in job loop: ${e.stack || e}`);
        }
      }

      // Auto-remove completed/failed/missed jobs, keep only pending
      const newJobs = jobs.filter(j => j.status === 'pending');
      if (mutated || newJobs.length !== jobs.length) {
        await saveJobs(row, newJobs);
      }
    });
  } catch (e) {
    logger.error(`[announce-jobs] tick failed: ${e.stack || e}`);
  }
}

module.exports = {
  enqueueAnnouncementJob,
  listPendingJobs,
  cancelAnnouncementJob,
  tickAnnounceJobs,
};
