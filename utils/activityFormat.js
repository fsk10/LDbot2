// utils/activityFormat.js

function bullet(label, value) {
  // value can be string/number/boolean/date/null/undefined
  let v;
  if (value === null || value === undefined || value === '') v = '—';
  else if (value instanceof Date) v = value.toString();
  else if (typeof value === 'boolean') v = value ? 'Yes' : 'No';
  else v = String(value);
  return `:white_small_square: **${label}**: ${v}`;
}

function yesNo(b) {
  return b ? 'Yes' : 'No';
}

function fmtDate(d) {
  if (!d) return '—';
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toString();
}

function formatValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (v instanceof Date) return v.toString();
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  // tolerate date-ish strings
  if (typeof v === 'string' && /\w{3}\s\w{3}/.test(v)) return v.toString();
  return String(v);
}

/**
 * Simple “state” log for adding/updating event user (no diff)
 */
function formatEventUserLog(actorTag, {
  action, // 'added' | 'updated' | 'removed' | 'registered'
  eventName, eventId,
  nick, userId,
  seat, paid, reserve, paidAt
}) {
  const header = `User **${nick}** was **${action}** in **${eventName}** by [ **${actorTag}** ]`;
  const lines = [
    header,
    bullet('Event', `${eventName} (ID ${eventId})`),
    bullet('User', `${nick} (ID ${userId})`),
    bullet('Seat', seat == null ? '—' : seat),
    bullet('Paid', yesNo(!!paid)),
    paid && paidAt ? bullet('Paid date', fmtDate(paidAt)) : null,
    bullet('Reserve', yesNo(!!reserve))
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * Diff log for event user updates. Only show changed fields.
 * changes: array of { label, before, after }
 */
function formatEventUserDiffLog(actorTag, {
  eventName, eventId,
  nick, userId,
  changes // [{label,before,after}]
}) {
  const header = `User **${nick}** was **updated** in **${eventName}** by [ **${actorTag}** ]`;

  const diffLines = (changes && changes.length)
    ? changes.map(c => {
        const label = String(c.label || '').trim();
        if (label.toLowerCase() === 'paid') {
          return bullet('Paid', `${yesNo(!!c.before)} → ${yesNo(!!c.after)}`);
        }
        if (label.toLowerCase() === 'paid date') {
          return bullet('Paid date', `${formatValue(c.before)} → ${formatValue(c.after)}`);
        }
        return bullet(label || 'Field', `${formatValue(c.before)} → ${formatValue(c.after)}`);
      })
    : [':white_small_square: No changes'];

  const lines = [
    header,
    bullet('Event', `${eventName} (ID ${eventId})`),
    bullet('User', `${nick} (ID ${userId})`),
    ...diffLines
  ].filter(Boolean);

  return lines.join('\n');
}

/** Admin chart logs */
function formatChartImportLog(actorTag, { eventName, eventId, chartId, imageName }) {
  const header = `Seating chart **imported** by [ **${actorTag}** ]`;
  const lines = [
    header,
    bullet('Event', `${eventName} (ID ${eventId})`),
    bullet('Chart ID', chartId),
    imageName ? bullet('Image', imageName) : null
  ].filter(Boolean);
  return lines.join('\n');
}

function formatChartSetLog(actorTag, { eventName, eventId, chartId }) {
  const header = `Seating chart **set** by [ **${actorTag}** ]`;
  const lines = [
    header,
    bullet('Event', `${eventName} (ID ${eventId})`),
    bullet('Chart ID', chartId)
  ];
  return lines.join('\n');
}

/** Optional generic helpers for other commands later */
function formatSimpleAction(actorTag, title, fields = []) {
  const header = `${title} by [ **${actorTag}** ]`;
  const lines = [
    header,
    ...fields.map(([label, value]) => bullet(label, value))
  ].filter(Boolean);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Pretty labels/values for event update logging                      */
/* ------------------------------------------------------------------ */

const EVENT_LABELS = {
  name: 'Name',
  location: 'Location',
  startdate: 'Starts',
  enddate: 'Ends',
  seatsavailable: 'Seats Available',
  entryfee: 'Entry Fee',
  participantchannel: 'Participant Channel',
  paymentconfig: 'Payment Config',
  adminrole: 'Event admin role',
  regopen: 'Registration Status',
};

function formatEventFieldValue(key, value) {
  if (value === null || value === undefined || value === '') {
    if (key === 'paymentconfig') return 'Default / Global';
    return '—';
  }

  if (key === 'adminrole') {
    // store raw role ID -> display as mention
    return `<@&${value}>`;
  }

  if (key === 'participantchannel') {
    // store raw channel ID -> display as mention
    const id = String(value).match(/\d{5,}/)?.[0];
    return id ? `<#${id}>` : String(value);
  }

  if (key === 'paymentconfig') {
    // strip ".json" and "paymentConfig_" prefix -> "Sweden"
    return String(value)
      .replace(/\.json$/i, '')
      .replace(/^paymentConfig_/i, '');
  }

  if (key === 'regopen') {
    return value ? 'Open' : 'Closed';
  }

  return formatValue(value);
}

function bulletEventField(key, value) {
  const label = EVENT_LABELS[key] || key;
  const pretty = formatEventFieldValue(key, value);
  return bullet(label, pretty);
}

function formatEventUpdateLog(actorTag, eventName, updatedFields) {
  const header = `Event **${eventName}** was **updated** by [ **${actorTag}** ]`;
  const lines = Object.entries(updatedFields).map(([k, v]) => bulletEventField(k, v));
  return [header, ...lines].join('\n');
}

module.exports = {
  bullet,
  yesNo,
  fmtDate,
  formatEventUserLog,
  formatEventUserDiffLog,
  formatChartImportLog,
  formatChartSetLog,
  formatSimpleAction,
  bulletEventField,
  formatEventUpdateLog,
};
