// scheduler/paymentReminders.js
// Automatic payment reminders by DM, run every 10 minutes from app.js.
// Per unpaid participant: reminder 1 and 2 go out at 12:00 Stockholm time on
// participantsince + reminderfirstday / remindersecondday. Rules:
//  - only reminders due after the schedule was switched on (reminderautosince)
//  - if the bot was offline past both, only the latest is sent
//  - nothing is sent after the last day to pay
const { Op } = require('sequelize');
const { EventModel } = require('../models');
const logger = require('../utils/logger');
const logActivity = require('../utils/logActivity');
const { withEventLock } = require('../utils/eventLock');
const { getReminderConfig } = require('../utils/reminderConfig');
const {
  getUnpaidParticipants, reminderDueAt, isOverdue, sendReminderDms, nameList,
} = require('../utils/paymentReminders');

// Which reminder (if any) to send now. Returns { reached, send }:
// reached = highest reminder number whose time has passed, send = true if it should be DM'd.
function dueReminder(row, event, now) {
  let reached = row.remindersent || 0;
  let dueAt = null;
  for (let n = reached + 1; n <= 2; n++) {
    const at = reminderDueAt(row, event, n);
    if (at > now) break;
    reached = n;
    dueAt = at;
  }
  if (!dueAt) return { reached, send: false };
  const since = new Date(event.reminderautosince);
  return { reached, send: dueAt >= since && !isOverdue(row, event, now) };
}

async function remindEvent(client, event, now) {
  const rows = (await getUnpaidParticipants(event.id)).filter(r => r.participantsince);
  const toSend = [];
  for (const row of rows) {
    const { reached, send } = dueReminder(row, event, now);
    if (reached === (row.remindersent || 0)) continue;
    // Count it as done before sending, so a failed DM is never retried every tick
    await row.update({ remindersent: reached });
    if (send) toSend.push(row);
  }
  if (!toSend.length) return;

  const { sent, failed } = await sendReminderDms(client, event, toSend, now);
  let msg = `💶 Automatic payment reminder for **${event.name}** sent by DM to **${sent.length}** user(s)`;
  if (sent.length) msg += `: ${nameList(sent)}`;
  if (failed.length) msg += `\n:white_small_square: Could not reach (DMs closed or left the server): ${nameList(failed, 300)}`;
  logActivity(client, msg, { eventId: event.id });
}

async function tickPaymentReminders(client) {
  if (!getReminderConfig()) return;
  try {
    await withEventLock('payment-reminders', async () => {
      const now = new Date();
      const events = await EventModel.findAll({
        where: {
          reminderauto: true,
          [Op.or]: [{ enddate: null }, { enddate: { [Op.gt]: now } }],
        },
      });
      for (const event of events) {
        try {
          // Switched on without a start time (should not happen): start counting now
          if (!event.reminderautosince) {
            await event.update({ reminderautosince: now });
            continue;
          }
          await remindEvent(client, event, now);
        } catch (e) {
          logger.error(`[payment-reminders] event ${event.id} failed: ${e.stack || e}`);
        }
      }
    });
  } catch (e) {
    logger.error(`[payment-reminders] tick failed: ${e.stack || e}`);
  }
}

module.exports = { tickPaymentReminders, dueReminder };
