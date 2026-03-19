const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { Op } = require('sequelize');
const fs = require('fs');
const path = require('path');
const { updateEvent, updateUser, updateEventUser, getAvailableSeatsForEvent, scheduleParticipantListUpdate } = require('../../database/operations');
const { UserModel, EventModel, EventUsersModel } = require('../../models');
const logActivity = require('../../utils/logActivity');
const { isAdmin } = require('../../utils/permissions');
const logger = require('../../utils/logger');
const { formatEventUserLog, formatEventUserDiffLog, bullet, bulletEventField, formatEventUpdateLog } = require('../../utils/activityFormat');
const { parseLocalToUTC } = require('../../utils/dateUtils');

const commandData = new SlashCommandBuilder()
  .setName('adminedit')
  .setDescription('Edit events, users, or event-specific user properties')
  .addSubcommand(subcommand =>
    subcommand.setName('event')
      .setDescription('Edit event properties')
      .addStringOption(option => option.setName('eventname').setDescription('Name of the event to edit').setRequired(true).setAutocomplete(true))
      .addStringOption(option => option.setName('name').setDescription('Name for the event (restart bot after change)'))
      .addStringOption(option => option.setName('location').setDescription('Location for the event'))
      .addStringOption(option => option.setName('startdate').setDescription('Start date and time (YYYY-MM-DD HH:mm)'))
      .addStringOption(option => option.setName('enddate').setDescription('End date and time (YYYY-MM-DD HH:mm)'))
      .addIntegerOption(option => option.setName('seatsavailable').setDescription('Number of available seats'))
      .addNumberOption(option => option.setName('entryfee').setDescription('Entry fee for the event'))
      .addStringOption(option => option.setName('participantchannel').setDescription('Participant channel for the event'))
      .addStringOption(option => option.setName('paymentconfig').setDescription('Payment config file (paymentConfig_*.json from /config)').setAutocomplete(true))
      .addRoleOption(option => option.setName('adminrole').setDescription('Event admin role'))
      .addBooleanOption(option => option.setName('regopen').setDescription('Allow public registration?'))
  )
  .addSubcommand(subcommand =>
    subcommand.setName('user')
      .setDescription('Edit general user properties')
      .addStringOption(option => option.setName('nickname').setDescription('Nickname of the user to edit').setRequired(true).setAutocomplete(true))
      .addStringOption(option => option.setName('newnickname').setDescription('New nickname for the user'))
      .addStringOption(option => option.setName('firstname').setDescription('First name for the user'))
      .addStringOption(option => option.setName('lastname').setDescription('Last name for the user'))
      .addStringOption(option => option.setName('country').setDescription('Country for the user (two-letter code)').setAutocomplete(true))
      .addStringOption(option => option.setName('email').setDescription('Email for the user'))
  )
  .addSubcommand(subcommand =>
    subcommand.setName('eventuser')
      .setDescription('Edit event-specific user properties')
      .addStringOption(option => option.setName('event').setDescription('Event for the user to edit').setRequired(true).setAutocomplete(true))
      .addStringOption(option => option.setName('nickname').setDescription('Nickname of the user to edit').setRequired(true).setAutocomplete(true))
      .addIntegerOption(option => option.setName('seat').setDescription('Seat number for the user'))
      .addBooleanOption(option => option.setName('haspaid').setDescription('Has the user paid?'))
      .addBooleanOption(option => option.setName('reserve').setDescription('Set the user as reserve'))
  );

async function prepare() {
  return commandData;
}

async function execute(interaction, client) {
  // perms
  const userIsAdmin = await isAdmin(interaction);
  if (!userIsAdmin) {
    const permissionErrorEmbed = new EmbedBuilder()
      .setTitle('Permission Denied')
      .setDescription("You don't have the required permissions to use this command.")
      .setColor('#FF0000');
    return interaction.reply({ embeds: [permissionErrorEmbed], ephemeral: true });
  }

  const subcommand = interaction.options.getSubcommand();

  try {
    if (subcommand === 'event') {
      await interaction.deferReply({ ephemeral: true });

      const eventName = interaction.options.getString('eventname');
      const originalEvent = await EventModel.findOne({ where: { id: eventName } });
      if (!originalEvent) {
        return interaction.editReply('Event not found.');
      }

      // Build the patch (exclude adminrole here; we normalize it separately)
      let updatedFields = {};
      for (let field of ['name', 'location', 'startdate', 'enddate', 'seatsavailable', 'entryfee', 'participantchannel', 'paymentconfig','regopen']) {
        const optionValue = interaction.options.get(field)?.value;
        if (optionValue !== undefined) updatedFields[field] = optionValue;
      }

      const startDateStr = interaction.options.getString('startdate'); // optional
      const endDateStr   = interaction.options.getString('enddate');   // optional

      // Parse Stockholm-local → UTC JS Date (only if provided)
      if (startDateStr) {
        const parsed = parseLocalToUTC(startDateStr);
        if (!parsed) {
          return interaction.editReply('Invalid start date-time. Use **YYYY-MM-DD HH:mm** (Stockholm time).');
        }
        updatedFields.startdate = parsed;
      }

      if (endDateStr) {
        const parsed = parseLocalToUTC(endDateStr);
        if (!parsed) {
          return interaction.editReply('Invalid end date-time. Use **YYYY-MM-DD HH:mm** (Stockholm time).');
        }
        updatedFields.enddate = parsed;
      }

      // Ensure start <= end if both are known (new or existing)
      const startToCheck = updatedFields.startdate ?? originalEvent.startdate;
      const endToCheck   = updatedFields.enddate   ?? originalEvent.enddate;
      if (startToCheck && endToCheck && (new Date(startToCheck) > new Date(endToCheck))) {
        return interaction.editReply('Start date cannot be after end date.');
      }


      // ---- Normalize & validate per-event payment config (optional) ----
      if (typeof updatedFields.paymentconfig === 'string') {
        const raw = updatedFields.paymentconfig.trim();

        // Empty string or special words → clear override (use global)
        if (!raw || ['none', 'clear', 'default'].includes(raw.toLowerCase())) {
          updatedFields.paymentconfig = null;
        } else {
          // Accept either "paymentConfig_Sweden" or "paymentConfig_Sweden.json"
          const base = raw.replace(/\.json$/i, '');
          const cfgPath = path.join(process.cwd(), 'config', `${base}.json`);
          if (!fs.existsSync(cfgPath)) {
            return interaction.editReply(`Payment config **${base}.json** was not found in /config.`);
          }
          updatedFields.paymentconfig = base; // store base only
        }
      }

      // ---- Normalize & validate adminrole (role picker only) ----
      {
        const rolePicked = interaction.options.getRole('adminrole');
        if (rolePicked) {
          updatedFields.adminrole = rolePicked.id; // store ID
        }
      }

      const result = await updateEvent(eventName, updatedFields, client);
      if (result.success) {
        // Pretty labels & values: Payment Config → “Sweden”, Event Adminrole → @Role, etc.
        const logText = formatEventUpdateLog(interaction.user.tag, originalEvent.name, updatedFields);
        logActivity(client, logText);
        return interaction.editReply('✅ Saved.');
      } else {
        logger.error(`Error updating event: ${result.message || result.error}`);
        return interaction.editReply(`Error updating event: ${result.message || result.error}`);
      }
    }

    if (subcommand === 'user') {
      await interaction.deferReply({ ephemeral: true });

      const nickname = interaction.options.getString('nickname');
      const userRow = await UserModel.findOne({ where: { nickname: { [Op.like]: nickname } } });
      if (!userRow) {
        return interaction.editReply(`No user found with nickname **${nickname}**.`);
      }

      const before = { ...userRow.get() };

      let updatedFields = {};
      const newNicknameValue = interaction.options.getString('newnickname');
      if (newNicknameValue !== null) {
        updatedFields['nickname'] = newNicknameValue;
      }
      for (let field of ['firstname', 'lastname', 'country', 'email']) {
        const optionValue = interaction.options.get(field)?.value;
        if (optionValue !== undefined) updatedFields[field] = optionValue;
      }

      const result = await updateUser(nickname, updatedFields, client);
      if (result.success) {
        const after = { ...before, ...updatedFields };
        const labelMap = { nickname: 'Nickname', firstname: 'First name', lastname: 'Last name', country: 'Country', email: 'Email' };
        const diffs = [];
        for (const key of Object.keys(updatedFields)) {
          if (before[key] !== after[key]) {
            diffs.push({ label: labelMap[key] || key, before: before[key], after: after[key] });
          }
        }

        const header = `User **${nickname}** was **updated** by [ **${interaction.user.tag}** ]`;
        const lines = diffs.length
          ? diffs.map(d => `:white_small_square: **${d.label}**: ${d.before ?? '—'} → ${d.after ?? '—'}`)
          : [':white_small_square: No changes'];
        logActivity(client, `${header}\n${lines.join('\n')}`);

        return interaction.editReply('✅ Saved.');
      } else {
        return interaction.editReply(`Error updating user: ${result.error}`);
      }
    }

    if (subcommand === 'eventuser') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const eventIdStr = interaction.options.getString('event', true);
        const nickname   = interaction.options.getString('nickname', true);
        const seatOpt    = interaction.options.getInteger('seat');       // optional
        const hasPaidOpt = interaction.options.getBoolean('haspaid');    // optional
        const reserveOpt = interaction.options.getBoolean('reserve');    // optional

        const eventId = Number(eventIdStr);
        const eventRecord = await EventModel.findByPk(eventId);
        if (!eventRecord) return interaction.editReply(`No event found with the ID: **${eventIdStr}**.`);

        const user = await UserModel.findOne({ where: { nickname: { [Op.like]: nickname } } });
        if (!user) return interaction.editReply(`No user found with the nickname: **${nickname}**.`);

        // Existing row (for before/after & logic)
        const current = await EventUsersModel.findOne({ where: { userId: user.id, eventId } });
        const before = current ? {
          seat: current.seat,
          haspaid: !!current.haspaid,
          reserve: !!current.reserve,
          paidAt: current.paidAt || null
        } : null;

        // Build intended updates from options
        const updatedFields = {};
        if (seatOpt !== null)    updatedFields.seat    = seatOpt;       // number
        if (hasPaidOpt !== null) updatedFields.haspaid = hasPaidOpt;    // boolean
        if (reserveOpt !== null) updatedFields.reserve = reserveOpt;    // boolean

        // Implicit reserve -> main if seat provided but reserve wasn't explicitly set
        if (before?.reserve === true && updatedFields.reserve === undefined && typeof updatedFields.seat === 'number') {
          updatedFields.reserve = false;
        }

        // If reserve true, force seat = null
        if (updatedFields.reserve === true) {
          updatedFields.seat = null;
        }

        // If assigning a seat to a main user, ensure not taken by someone else (do this BEFORE any writes)
        if ((updatedFields.reserve === false || (before && before.reserve === false)) && typeof updatedFields.seat === 'number') {
          const taken = await EventUsersModel.findOne({
            where: {
              eventId,
              seat: updatedFields.seat,
              userId: { [Op.ne]: user.id }
            }
          });
          if (taken) {
            return interaction.editReply(`Seat **${updatedFields.seat}** is already taken in **${eventRecord.name}**.`);
          }
        }

        // CREATE
        if (!current) {
          const row = await EventUsersModel.create({
            userId: user.id,
            eventId,
            seat: updatedFields.seat ?? null,
            haspaid: updatedFields.haspaid ?? false,    // do not auto-true
            paidAt: (updatedFields.haspaid ? new Date() : null),
            reserve: updatedFields.reserve ?? false,
            status: 'confirmed'
          });

          logActivity(client, formatEventUserLog(interaction.user.tag, {
            action: 'added',
            eventName: eventRecord.name,
            eventId: eventRecord.id,
            nick: user.nickname,
            userId: user.id,
            seat: row.reserve ? null : row.seat,
            paid: !!row.haspaid,
            reserve: !!row.reserve,
            paidAt: row.paidAt || null
          }));

          // Debounced refresh for new rows
          scheduleParticipantListUpdate(client, eventId);
          return interaction.editReply('✅ Saved.');
        }

        // UPDATE
        // Only set paidAt when turning paid on; if explicitly turning off, clear it
        if ('haspaid' in updatedFields) {
          updatedFields.paidAt = updatedFields.haspaid ? new Date() : null;
        }

        const result = await updateEventUser(eventId, user.id, updatedFields, client);
        if (!result.success) {
          return interaction.editReply('Error updating user-event details. Please try again.');
        }

        const afterRow = await EventUsersModel.findOne({ where: { userId: user.id, eventId } });
        const after = {
          seat: afterRow.seat,
          haspaid: !!afterRow.haspaid,
          reserve: !!afterRow.reserve,
          paidAt: afterRow.paidAt || null
        };

        const diffs = [];
        if (before.seat !== after.seat)       diffs.push({ label: 'Seat',    before: before.seat,   after: after.seat });
        if (before.haspaid !== after.haspaid) diffs.push({ label: 'Paid',    before: before.haspaid, after: after.haspaid });
        if (before.reserve !== after.reserve) diffs.push({ label: 'Reserve', before: before.reserve, after: after.reserve });
        if (after.haspaid && after.paidAt && (!before.paidAt || +new Date(before.paidAt) !== +new Date(after.paidAt))) {
          diffs.push({ label: 'Paid date', before: before.paidAt, after: after.paidAt });
        }

        logActivity(client, formatEventUserDiffLog(interaction.user.tag, {
          eventName: eventRecord.name,
          eventId: eventRecord.id,
          nick: user.nickname,
          userId: user.id,
          changes: diffs
        }));

        // No explicit participant-list update here — updateEventUser schedules it.
        return interaction.editReply('✅ Saved.');

      } catch (err) {
        logger.error("Error in /adminedit eventuser:", err);
        return interaction.editReply('An error occurred. Please try again.');
      }
    }

    return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
  } catch (error) {
    logger.error("Error in /adminedit:", error);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply('An error occurred. Please try again.');
    }
    return interaction.reply({ content: 'An error occurred. Please try again.', ephemeral: true });
  }
}

module.exports = {
  data: commandData,
  execute,
  prepare
};
