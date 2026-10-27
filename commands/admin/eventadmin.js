// commands/admin/eventadmin.js
const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Op } = require('sequelize');
const { isEventAdminForEvent } = require('../../utils/permissions');
const { UserModel, EventModel, EventUsersModel } = require('../../models');
const { scheduleParticipantListUpdate, getSeatEligibility } = require('../../database/operations');
const logActivity = require('../../utils/logActivity');
const announceRegistration = require('../../utils/announceRegistration');
const logger = require('../../utils/logger');
const { formatEventUserLog, formatEventUserDiffLog, formatEventUpdateLog } = require('../../utils/activityFormat');
const { listUsers } = require('../../database/operations');
const { getNameFromID } = require('../../utils/getNameFromID');
const { getReminderConfig } = require('../../utils/reminderConfig');
const {
  ReminderError, validateReminderDays, getUnpaidParticipants, getReminderChannel,
  sendReminderDms, postChannelReminder, nickOf, nameList,
} = require('../../utils/paymentReminders');

const CONFIRM_TIMEOUT_MS = 60 * 1000;

const data = new SlashCommandBuilder()
  .setName('eventadmin')
  .setDescription('Event-scoped admin actions')
  // list
  .addSubcommand(sc => sc
    .setName('list')
    .setDescription('List users for this event')
    .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('output').setDescription('Output format').addChoices(
      { name: 'Short', value: 'short' },
      { name: 'Full',  value: 'full'  }
    ))
  )
  // seat
  .addSubcommand(sc => sc
    .setName('seat')
    .setDescription('Set/change a user seat (makes them a participant, not reserve)')
    .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('nickname').setDescription('User nickname').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('seat').setDescription('Seat number').setRequired(true)))
  // Paid
  .addSubcommand(sc => sc
    .setName('paid')
    .setDescription('Mark user as paid/unpaid')
    .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('nickname').setDescription('User nickname').setRequired(true).setAutocomplete(true))
    .addBooleanOption(o => o.setName('paid').setDescription('Has paid?').setRequired(true)))
  // reserve
  .addSubcommand(sc => sc
    .setName('reserve')
    .setDescription('Set or unset reserve status (reserve clears seat)')
    .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('nickname').setDescription('User nickname').setRequired(true).setAutocomplete(true))
    .addBooleanOption(o => o.setName('reserve').setDescription('Reserve?').setRequired(true)))
  // register
  .addSubcommand(sc => sc
    .setName('register')
    .setDescription('Add an existing bot user to the event (works even when registration is closed)')
    .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('nickname').setDescription('User nickname').setRequired(true).setAutocomplete(true))
    .addIntegerOption(o => o.setName('seat').setDescription('Seat number (makes them a participant)').setMinValue(1))
    .addBooleanOption(o => o.setName('paid').setDescription('Has paid?'))
    .addBooleanOption(o => o.setName('reserve').setDescription('Reserve? (default: reserve only if the event is full)')))
  // unregister
  .addSubcommand(sc => sc
    .setName('unregister')
    .setDescription('Unregister a user from the event')
    .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
    .addStringOption(o => o.setName('nickname').setDescription('User nickname').setRequired(true).setAutocomplete(true)))
  // regopen
  .addSubcommand(sc => sc
    .setName('regopen')
    .setDescription('Open or close registration for your event')
    .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
    .addBooleanOption(o => o.setName('open').setDescription('Set registration open? (true=open, false=closed)').setRequired(true)))
  // payment reminders
  .addSubcommandGroup(g => g
    .setName('reminder')
    .setDescription('Payment reminders for unpaid participants')
    .addSubcommand(sc => sc
      .setName('send')
      .setDescription('Remind unpaid participants now (shows a preview first)')
      .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('via').setDescription('How to remind them').setRequired(true).addChoices(
        { name: 'DM to each unpaid participant', value: 'dm' },
        { name: 'Tag them in the reminder channel', value: 'channel' }
      )))
    .addSubcommand(sc => sc
      .setName('settings')
      .setDescription('Show or change automatic payment reminders for your event')
      .addStringOption(o => o.setName('event').setDescription('Event').setRequired(true).setAutocomplete(true))
      .addBooleanOption(o => o.setName('auto').setDescription('Send automatic reminders by DM?'))
      .addIntegerOption(o => o.setName('first_day').setDescription('First reminder, days after signup (default 7)').setMinValue(1).setMaxValue(365))
      .addIntegerOption(o => o.setName('second_day').setDescription('Second reminder, days after signup (default 13)').setMinValue(1).setMaxValue(365))
      .addIntegerOption(o => o.setName('payment_days').setDescription('Days to pay after signup (default 14)').setMinValue(1).setMaxValue(365))));

async function splitEmbeds(users, eventName, interaction, outputType = 'short') {
  const MAX_SIZE = 4096;
  const embeds = [];
  let desc = '​'; // zero-width char
  let count = desc.length;

  async function safeDiscordName(discordUserId) {
    try {
      const nameResult = await getNameFromID(interaction, discordUserId);
      return (nameResult && nameResult.type === 'user' && nameResult.name) ? nameResult.name : 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  for (const user of (users || [])) {
    const country = (user?.country || 'xx').toLowerCase();
    const nickname = user?.nickname || '(no nickname)';
    const first = user?.firstname || '';
    const last = user?.lastname || '';
    const email = user?.email || '';
    const discordId = user?.discorduser || '';
    const discordName = await safeDiscordName(discordId);

    // Try both shapes (depending on your listUsers implementation)
    const eu = user?.events?.[0]?.EventUsers || user?.EventUsers || {};
    const seat = (eu.seat !== undefined && eu.seat !== null) ? eu.seat : 'N/A';
    const haspaid = !!eu.haspaid;
    const reserve = !!eu.reserve;

    const notPaidIndicator = (!haspaid && !reserve) ? ' :small_orange_diamond:' : '';
    const reserveIndicator = reserve ? ' :small_red_triangle:' : '';
    const flag = `:flag_${country}:`;
    const seatText = (!reserve && seat !== 'N/A') ? `[#${seat}]` : '';

    let line;
    if (outputType === 'short') {
      line = `${flag} **${nickname}** (${discordName}) ${seatText}${reserveIndicator}${notPaidIndicator}\n`;
    } else {
      line =
        `**${nickname}**\n` +
        `User ID: ${user?.id ?? ''}\n` +
        `Discord Name: ${discordName}\n` +
        `Discord ID: ${discordId}\n` +
        `Reserve: ${reserve ? 'Yes' : 'No'}\n` +
        `${seat !== 'N/A' ? `Seat: ${seat}\n` : ''}` +
        `Paid: ${haspaid ? 'Yes' : 'No'}\n` +
        `Full Name: ${first} ${last}\n` +
        `Email: ${email}\n` +
        `Country: ${flag}\n\n`;
    }

    if (count + line.length > MAX_SIZE) {
      embeds.push(new EmbedBuilder().setTitle(`User List (${eventName})`).setDescription(desc).setColor('#0089E4'));
      desc = '​';
      count = desc.length;
    }

    desc += line;
    count += line.length;
  }

  if (count > 0) {
    embeds.push(
      new EmbedBuilder()
        .setTitle(`User List (${eventName})`)
        .setDescription(`:small_red_triangle: Reserve   :small_orange_diamond: Unpaid entry fee\n\n${desc}`)
        .setColor('#0089E4')
    );
  }

  return embeds;
}

function reminderSettingsText(event) {
  const cfg = getReminderConfig();
  return [
    `**Payment reminders for ${event.name}**`,
    `:white_small_square: **Automatic reminders by DM**: ${event.reminderauto ? 'On' : 'Off'}`,
    `:white_small_square: **First reminder**: day ${event.reminderfirstday} after signup, 12:00`,
    `:white_small_square: **Second reminder**: day ${event.remindersecondday} after signup, 12:00`,
    `:white_small_square: **Last day to pay**: day ${event.paymentdays} after signup`,
    `:white_small_square: **Reminder channel**: ${cfg ? `<#${cfg.channelId}>` : 'not configured'}`,
  ].join('\n');
}

// Preview + [Send]/[Cancel]. Resolves true on Send; on Cancel or timeout the
// reply says nothing was sent and it resolves false.
async function confirmReminder(interaction, content) {
  const sendId = `reminder_send:${interaction.id}`;
  const cancelId = `reminder_cancel:${interaction.id}`;
  const message = await interaction.editReply({
    content,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(sendId).setLabel('Send').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )]
  });

  let click;
  try {
    click = await message.awaitMessageComponent({
      filter: i => i.user.id === interaction.user.id && (i.customId === sendId || i.customId === cancelId),
      time: CONFIRM_TIMEOUT_MS
    });
  } catch {
    await interaction.editReply({ content: '⏱️ No answer, nothing was sent.', components: [] }).catch(() => {});
    return false;
  }
  if (click.customId === cancelId) {
    await click.update({ content: 'Cancelled, nothing was sent.', components: [] }).catch(() => {});
    return false;
  }
  await click.update({ content: 'Sending reminders…', components: [] }).catch(() => {});
  return true;
}

async function handleReminderSend(interaction, client, event) {
  const via = interaction.options.getString('via', true);
  if (!getReminderConfig()) {
    return interaction.editReply('❌ Payment reminders are not configured on this bot. Nothing was sent.');
  }

  let channel = null;
  try {
    if (via === 'channel') channel = await getReminderChannel(client);
  } catch (e) {
    if (e instanceof ReminderError) return interaction.editReply(`❌ ${e.message} Nothing was sent.`);
    throw e;
  }

  const preview = await getUnpaidParticipants(event.id);
  if (!preview.length) {
    return interaction.editReply(`✅ Everyone in **${event.name}** has paid. No reminder needed.`);
  }

  const target = via === 'dm' ? 'by DM' : `in <#${channel.id}>`;
  const ok = await confirmReminder(interaction,
    `Remind **${preview.length}** unpaid participant(s) of **${event.name}** ${target}?\n${nameList(preview.map(nickOf))}`);
  if (!ok) return;

  // Re-read: someone may have paid while the preview was open
  const rows = await getUnpaidParticipants(event.id);
  if (!rows.length) {
    return interaction.editReply({ content: `✅ Everyone in **${event.name}** has paid now. Nothing was sent.`, components: [] });
  }

  if (via === 'dm') {
    const { sent, failed } = await sendReminderDms(client, event, rows);
    let log = `💶 Payment reminder for **${event.name}** sent by DM by [ **${interaction.user.tag}** ] to **${sent.length}** user(s)`;
    if (sent.length) log += `: ${nameList(sent)}`;
    if (failed.length) log += `\n:white_small_square: Could not reach (DMs closed or left the server): ${nameList(failed, 300)}`;
    logActivity(client, log, { eventId: event.id });

    let reply = `✅ Sent a payment reminder by DM to **${sent.length}** user(s).`;
    if (failed.length) reply += `\n⚠️ Could not reach: ${nameList(failed)}`;
    return interaction.editReply({ content: reply, components: [] });
  }

  try {
    await postChannelReminder(client, event, rows);
  } catch (e) {
    if (e instanceof ReminderError) return interaction.editReply({ content: `❌ ${e.message} Nothing was sent.`, components: [] });
    throw e;
  }
  logActivity(client,
    `💶 Payment reminder for **${event.name}** posted in <#${channel.id}> by [ **${interaction.user.tag}** ], **${rows.length}** user(s) tagged: ${nameList(rows.map(nickOf))}`,
    { eventId: event.id });
  return interaction.editReply({ content: `✅ Posted a payment reminder in <#${channel.id}> tagging **${rows.length}** user(s).`, components: [] });
}

async function handleReminderSettings(interaction, client, event) {
  const auto = interaction.options.getBoolean('auto');
  const first = interaction.options.getInteger('first_day');
  const second = interaction.options.getInteger('second_day');
  const payment = interaction.options.getInteger('payment_days');

  if (auto === null && first === null && second === null && payment === null) {
    return interaction.editReply(reminderSettingsText(event));
  }

  const error = validateReminderDays({
    first: first ?? event.reminderfirstday,
    second: second ?? event.remindersecondday,
    payment: payment ?? event.paymentdays,
  });
  if (error) return interaction.editReply(`❌ ${error} Nothing was changed.`);

  const changes = {};
  if (auto !== null && auto !== event.reminderauto) changes.reminderauto = auto;
  if (first !== null && first !== event.reminderfirstday) changes.reminderfirstday = first;
  if (second !== null && second !== event.remindersecondday) changes.remindersecondday = second;
  if (payment !== null && payment !== event.paymentdays) changes.paymentdays = payment;
  if (!Object.keys(changes).length) {
    return interaction.editReply(`No changes.\n${reminderSettingsText(event)}`);
  }

  // Switching on only covers reminders from now on
  await event.update(changes.reminderauto ? { ...changes, reminderautosince: new Date() } : changes);
  logActivity(client, formatEventUpdateLog(interaction.user.tag, event.name, changes), { eventId: event.id });
  return interaction.editReply(`✅ Saved.\n${reminderSettingsText(event)}`);
}

async function execute(interaction, client) {
  const sub = interaction.options.getSubcommand(true);
  const eventIdStr = interaction.options.getString('event', true);
  const eventId = Number(eventIdStr);

  try {
    await interaction.deferReply({ ephemeral: true });

    // ✅ Event-scoped permission gate
    const ok = await isEventAdminForEvent(interaction, eventId);
    if (!ok) return interaction.editReply('You are not an admin for this event.');

    // Resolve event
    const event = await EventModel.findByPk(eventId);
    if (!event) return interaction.editReply('Event not found.');

    const eventEnded = event.enddate && new Date(event.enddate) < new Date();

    // ----- LIST -----
    if (sub === 'list') {
      const outputType = interaction.options.getString('output') || 'short';
      const users = await listUsers(eventId);
      if (!users || users.length === 0) {
        return interaction.editReply({ content: `No users found for **${event.name}**.` });
      }
      const embeds = await splitEmbeds(users, event.name, interaction, outputType);
      await interaction.editReply({ embeds: [embeds[0]] });
      for (let i = 1; i < embeds.length; i++) {
        await interaction.followUp({ embeds: [embeds[i]], ephemeral: true });
      }
      return;
    }

    if (eventEnded) {
      return interaction.editReply(`❌ **${event.name}** has ended. No further changes can be made via this command.`);
    }

    if (interaction.options.getSubcommandGroup(false) === 'reminder') {
      if (sub === 'send') return await handleReminderSend(interaction, client, event);
      if (sub === 'settings') return await handleReminderSettings(interaction, client, event);
    }

    if (sub === 'regopen') {
      const wantOpen = interaction.options.getBoolean('open', true);

      const beforeOpen = !!event.regopen;
      await event.update({ regopen: wantOpen });

      logActivity(client, formatEventUpdateLog(
        interaction.user.tag,
        event.name,
        { regopen: wantOpen } // helper renders boolean as Yes/No via formatValue()
      ), { eventId: event.id });

      return interaction.editReply(`✅ Registration for **${event.name}** is now **${wantOpen ? 'Open' : 'Closed'}**.`);
    }

    // For the other subcommands we now resolve nickname when needed
    const nickname = interaction.options.getString('nickname', true);

    // Resolve user
    const user = await UserModel.findOne({ where: { nickname: { [Op.like]: nickname } } });
    if (!user) return interaction.editReply(`No user found with nickname **${nickname}**.`);

    let row = await EventUsersModel.findOne({ where: { userId: user.id, eventId } });

    if (sub === 'register') {
      if (row) return interaction.editReply(`User **${user.nickname}** is already registered in **${event.name}**.`);

      const seat = interaction.options.getInteger('seat');
      const paid = interaction.options.getBoolean('paid') ?? false;
      const reserveOpt = interaction.options.getBoolean('reserve');

      if (reserveOpt === true && seat !== null) {
        return interaction.editReply('A reserve cannot have a seat. Leave out either **seat** or **reserve**.');
      }

      let reserve = reserveOpt;
      if (reserve === null) {
        if (seat !== null) {
          reserve = false;
        } else {
          // Reserves go first: the newcomer only gets a seat if one is free beyond the queue
          const { canTakeSeat } = await getSeatEligibility(eventId, user.id);
          reserve = !canTakeSeat;
        }
      }

      if (seat !== null) {
        const taken = await EventUsersModel.findOne({ where: { eventId, seat } });
        if (taken) return interaction.editReply(`Seat **${seat}** is already taken in **${event.name}**.`);
      }

      row = await EventUsersModel.create({
        userId: user.id,
        eventId,
        seat: reserve ? null : seat,
        haspaid: paid,
        paidAt: paid ? new Date() : null,
        reserve,
        status: 'confirmed'
      });
      await scheduleParticipantListUpdate(client, eventId);

      logActivity(client, formatEventUserLog(interaction.user.tag, {
        action: 'added', eventName: event.name, eventId: event.id, nick: user.nickname, userId: user.id,
        seat: row.seat, paid: !!row.haspaid, reserve: !!row.reserve, paidAt: row.paidAt || null
      }), { eventId: event.id });
      announceRegistration(client, event.id, user.nickname, 'registered');

      const placement = row.reserve ? 'as **reserve**' : (row.seat ? `on seat **#${row.seat}**` : 'as **participant** (no seat yet)');
      return interaction.editReply(`✅ Registered **${user.nickname}** in **${event.name}** ${placement}.`);
    }

    // seat/paid/reserve/unregister only work on users already in the event
    if (!row) {
      return interaction.editReply(`User **${user.nickname}** is not registered in **${event.name}**. Use **/eventadmin register** first.`);
    }

    const before = {
      seat: row.seat, haspaid: !!row.haspaid, reserve: !!row.reserve, paidAt: row.paidAt || null
    };

    if (sub === 'seat') {
      const seat = interaction.options.getInteger('seat', true);

      const taken = await EventUsersModel.findOne({
        where: { eventId, seat, userId: { [Op.ne]: user.id } }
      });
      if (taken) return interaction.editReply(`Seat **${seat}** is already taken in **${event.name}**.`);

      await row.update({ seat, reserve: false });
      await scheduleParticipantListUpdate(client, eventId);

      const diffs = [];
      if ((before.seat ?? null) !== seat) diffs.push({ label: 'Seat', before: before.seat ?? null, after: seat });
      if (before.reserve !== false) diffs.push({ label: 'Reserve', before: before.reserve, after: false });
      logActivity(client, formatEventUserDiffLog(interaction.user.tag, {
        eventName: event.name, eventId: event.id, nick: user.nickname, userId: user.id, changes: diffs
      }), { eventId: event.id });

      return interaction.editReply(`✅ Set **${nickname}** to seat **#${seat}** (participant).`);
    }

    if (sub === 'paid') {
      const paid = interaction.options.getBoolean('paid', true);

      const patch = { haspaid: paid, paidAt: paid ? new Date() : null };
      await row.update(patch);
      await scheduleParticipantListUpdate(client, eventId);

      const diffs = [];
      if (before.haspaid !== paid) diffs.push({ label: 'Paid', before: before.haspaid, after: paid });
      if (paid) diffs.push({ label: 'Paid date', before: before.paidAt, after: row.paidAt });
      logActivity(client, formatEventUserDiffLog(interaction.user.tag, {
        eventName: event.name, eventId: event.id, nick: user.nickname, userId: user.id, changes: diffs
      }), { eventId: event.id });

      return interaction.editReply(`✅ Marked **${nickname}** as **${paid ? 'PAID' : 'UNPAID'}**.`);
    }

    if (sub === 'reserve') {
      const reserve = interaction.options.getBoolean('reserve', true);

      const patch = { reserve };
      if (reserve) patch.seat = null; // reserve clears seat
      await row.update(patch);
      await scheduleParticipantListUpdate(client, eventId);

      const diffs = [];
      if (before.reserve !== reserve) diffs.push({ label: 'Reserve', before: before.reserve, after: reserve });
      if (reserve && (before.seat !== null)) diffs.push({ label: 'Seat', before: before.seat, after: null });
      logActivity(client, formatEventUserDiffLog(interaction.user.tag, {
        eventName: event.name, eventId: event.id, nick: user.nickname, userId: user.id, changes: diffs
      }), { eventId: event.id });

      return interaction.editReply(`✅ ${reserve ? 'Set' : 'Unset'} **reserve** for **${nickname}**.`);
    }

    if (sub === 'unregister') {
      await row.destroy();
      await scheduleParticipantListUpdate(client, eventId);

      logActivity(client, `User **${user.nickname}** was **removed** from **${event.name}** by [ **${interaction.user.tag}** ]`, { eventId: event.id });
      announceRegistration(client, event.id, user.nickname, 'left');
      return interaction.editReply(`✅ Unregistered **${nickname}** from **${event.name}**.`);
    }

    return interaction.editReply('Unknown subcommand.');
  } catch (err) {
    logger.error('[eventadmin] error:', err);
    if (interaction.deferred || interaction.replied) {
      return interaction.editReply('❌ Error. Please try again.');
    }
    return interaction.reply({ content: '❌ Error. Please try again.', ephemeral: true });
  }
}

async function prepare() {
  // nothing special; autocompletes are handled globally in InteractionCreate
  return data;
}

module.exports = { data, execute, prepare };
