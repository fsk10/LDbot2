// utils/paymentReminders.js
// Payment reminders for unpaid participants (haspaid = false, not reserve).
// The deadline counts from eventUsers.participantsince; texts and the channel
// come from config/reminderConfig.json (utils/reminderConfig.js).
const { DateTime } = require('luxon');
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const { EventUsersModel, UserModel } = require('../models');
const { getReminderConfig, fillTemplate } = require('./reminderConfig');
const logger = require('./logger');

const TZ = 'Europe/Stockholm';
const SEND_HOUR = 12; // automatic reminders go out at 12:00 Stockholm time
const MAX_MESSAGE = 2000;
const REMINDER_DAY_FIELDS = ['reminderfirstday', 'remindersecondday'];

// Message is safe to show admins; details go to the bot log.
class ReminderError extends Error {}

function startDay(row) {
  return DateTime.fromJSDate(new Date(row.participantsince)).setZone(TZ).startOf('day');
}

// Last day to pay, as a Stockholm calendar date.
function deadlineDate(row, event) {
  return startDay(row).plus({ days: Number(event.paymentdays) });
}

function deadlineLabel(row, event) {
  return deadlineDate(row, event).toFormat('yyyy-MM-dd');
}

function isOverdue(row, event, now = new Date()) {
  return DateTime.fromJSDate(now) > deadlineDate(row, event).endOf('day');
}

// When automatic reminder n (1 or 2) is due for this participant.
function reminderDueAt(row, event, n) {
  const days = Number(event[REMINDER_DAY_FIELDS[n - 1]]);
  return startDay(row).plus({ days }).set({ hour: SEND_HOUR }).toJSDate();
}

// Returns an error message, or null if the combination is valid.
function validateReminderDays({ first, second, payment }) {
  for (const [name, v] of [['first_day', first], ['second_day', second], ['payment_days', payment]]) {
    if (!Number.isInteger(v) || v < 1 || v > 365) return `${name} must be a whole number from 1 to 365.`;
  }
  if (!(first < second)) return 'The first reminder must come before the second.';
  if (!(second < payment)) return 'The second reminder must come before the last day to pay.';
  return null;
}

// Unpaid participants, with their user row, sorted by seat.
async function getUnpaidParticipants(eventId) {
  return EventUsersModel.findAll({
    where: { eventId, haspaid: false, reserve: false },
    include: [{ model: UserModel, as: 'user', attributes: ['id', 'nickname', 'discorduser'] }],
    order: [['seat', 'ASC']],
  });
}

function nickOf(row) {
  return row.user?.nickname || `user ${row.userId}`;
}

// Comma-separated names, cut so a log line stays well under Discord's limit.
function nameList(names, max = 1500) {
  const text = names.join(', ');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function dmText(cfg, event, row, now = new Date()) {
  const template = isOverdue(row, event, now) ? cfg.dm.overdueText : cfg.dm.text;
  return fillTemplate(template, {
    event: event.name,
    seat: row.seat ?? '—',
    deadline: deadlineLabel(row, event),
  });
}

/**
 * DM each row. Returns { sent: [nick], failed: [nick] }; one failure never
 * stops the rest (closed DMs, left the server).
 */
async function sendReminderDms(client, event, rows, now = new Date()) {
  const cfg = getReminderConfig();
  if (!cfg) throw new ReminderError('Payment reminders are not configured on this bot.');
  const sent = [];
  const failed = [];
  for (const row of rows) {
    try {
      const user = await client.users.fetch(row.user.discorduser);
      await user.send({ content: dmText(cfg, event, row, now), allowedMentions: { parse: [] } });
      sent.push(nickOf(row));
    } catch (e) {
      logger.warn(`Payment reminder DM to ${nickOf(row)} (event ${event.id}) failed: ${e.message}`);
      failed.push(nickOf(row));
    }
  }
  return { sent, failed };
}

// Channel text split into messages under Discord's 2000 character limit.
function buildChannelMessages(cfg, event, rows, now = new Date()) {
  const title = fillTemplate(cfg.channel.title, { event: event.name });
  const footer = fillTemplate(cfg.channel.footer, { event: event.name });
  const lines = rows.map(row => fillTemplate(
    isOverdue(row, event, now) ? cfg.channel.overdueLine : cfg.channel.line,
    { mention: `<@${row.user.discorduser}>`, deadline: deadlineLabel(row, event), seat: row.seat ?? '—', event: event.name }
  ));

  const messages = [];
  let current = title;
  for (const line of [...lines, '', footer]) {
    if (current.length + 1 + line.length > MAX_MESSAGE) {
      messages.push(current);
      current = line;
    } else {
      current += `\n${line}`;
    }
  }
  messages.push(current);
  return messages.map(m => m.slice(0, MAX_MESSAGE));
}

// Fetch the configured reminder channel and check the bot can post there.
async function getReminderChannel(client) {
  const cfg = getReminderConfig();
  if (!cfg) throw new ReminderError('Payment reminders are not configured on this bot.');

  let channel;
  try {
    channel = await client.channels.fetch(cfg.channelId);
  } catch (e) {
    logger.warn(`Payment reminder channel ${cfg.channelId} could not be fetched: ${e.message}`);
    throw new ReminderError('The bot cannot reach the reminder channel.');
  }
  if (!channel || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new ReminderError('The reminder channel is not a text channel.');
  }
  const me = channel.guild.members.me ?? await channel.guild.members.fetchMe();
  const perms = channel.permissionsFor(me);
  const missing = [[PermissionFlagsBits.ViewChannel, 'View Channel'], [PermissionFlagsBits.SendMessages, 'Send Messages']]
    .filter(([flag]) => !perms?.has(flag)).map(([, label]) => label);
  if (missing.length) {
    throw new ReminderError(`The bot is missing permissions in the reminder channel: ${missing.join(', ')}.`);
  }
  return channel;
}

// Posts the channel reminder; only the listed users are pinged.
async function postChannelReminder(client, event, rows, now = new Date()) {
  const channel = await getReminderChannel(client);
  const cfg = getReminderConfig();
  for (const content of buildChannelMessages(cfg, event, rows, now)) {
    const users = [...content.matchAll(/<@(\d+)>/g)].map(m => m[1]);
    await channel.send({ content, allowedMentions: { parse: [], users } });
  }
  return channel;
}

module.exports = {
  ReminderError,
  deadlineLabel,
  isOverdue,
  reminderDueAt,
  validateReminderDays,
  getUnpaidParticipants,
  getReminderChannel,
  sendReminderDms,
  postChannelReminder,
  buildChannelMessages,
  nickOf,
  nameList,
};
