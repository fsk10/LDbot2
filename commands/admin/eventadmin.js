// commands/admin/eventadmin.js
const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { Op } = require('sequelize');
const { isEventAdminForEvent } = require('../../utils/permissions');
const { UserModel, EventModel, EventUsersModel } = require('../../models');
const { scheduleParticipantListUpdate } = require('../../database/operations');
const logActivity = require('../../utils/logActivity');
const logger = require('../../utils/logger');
const { formatEventUserLog, formatEventUserDiffLog, formatEventUpdateLog } = require('../../utils/activityFormat');
const { listUsers } = require('../../database/operations');
const { getNameFromID } = require('../../utils/getNameFromID');

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
    .addBooleanOption(o => o.setName('open').setDescription('Set registration open? (true=open, false=closed)').setRequired(true)));

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

    if (sub === 'regopen') {
      const wantOpen = interaction.options.getBoolean('open', true);

      const beforeOpen = !!event.regopen;
      await event.update({ regopen: wantOpen });

      logActivity(client, formatEventUpdateLog(
        interaction.user.tag,
        event.name,
        { regopen: wantOpen } // helper renders boolean as Yes/No via formatValue()
      ));

      const ended = event.enddate && new Date(event.enddate) < new Date();
      const suffix = ended ? ' (note: the event has already ended)' : '';
      return interaction.editReply(`✅ Registration for **${event.name}** is now **${wantOpen ? 'Open' : 'Closed'}**.${suffix}`);
    }

    // For the other subcommands we now resolve nickname when needed
    const nickname = interaction.options.getString('nickname', true);

    // Resolve user
    const user = await UserModel.findOne({ where: { nickname: { [Op.like]: nickname } } });
    if (!user) return interaction.editReply(`No user found with nickname **${nickname}**.`);

    // Existing row (or lazily create when needed)
    let row = await EventUsersModel.findOne({ where: { userId: user.id, eventId } });

    async function ensureRow() {
      if (!row) {
        row = await EventUsersModel.create({
          userId: user.id,
          eventId,
          seat: null,
          haspaid: false,
          paidAt: null,
          reserve: true,
          status: 'confirmed'
        });
      }
    }

    const before = row ? {
      seat: row.seat, haspaid: !!row.haspaid, reserve: !!row.reserve, paidAt: row.paidAt || null
    } : { seat: null, haspaid: false, reserve: false, paidAt: null };

    if (sub === 'seat') {
      const seat = interaction.options.getInteger('seat', true);
      await ensureRow();

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
      }));

      return interaction.editReply(`✅ Set **${nickname}** to seat **#${seat}** (participant).`);
    }

    if (sub === 'paid') {
      const paid = interaction.options.getBoolean('paid', true);
      await ensureRow();

      const patch = { haspaid: paid, paidAt: paid ? new Date() : null };
      await row.update(patch);
      await scheduleParticipantListUpdate(client, eventId);

      const diffs = [];
      if (before.haspaid !== paid) diffs.push({ label: 'Paid', before: before.haspaid, after: paid });
      if (paid) diffs.push({ label: 'Paid date', before: before.paidAt, after: row.paidAt });
      logActivity(client, formatEventUserDiffLog(interaction.user.tag, {
        eventName: event.name, eventId: event.id, nick: user.nickname, userId: user.id, changes: diffs
      }));

      return interaction.editReply(`✅ Marked **${nickname}** as **${paid ? 'PAID' : 'UNPAID'}**.`);
    }

    if (sub === 'reserve') {
      const reserve = interaction.options.getBoolean('reserve', true);
      await ensureRow();

      const patch = { reserve };
      if (reserve) patch.seat = null; // reserve clears seat
      await row.update(patch);
      await scheduleParticipantListUpdate(client, eventId);

      const diffs = [];
      if (before.reserve !== reserve) diffs.push({ label: 'Reserve', before: before.reserve, after: reserve });
      if (reserve && (before.seat !== null)) diffs.push({ label: 'Seat', before: before.seat, after: null });
      logActivity(client, formatEventUserDiffLog(interaction.user.tag, {
        eventName: event.name, eventId: event.id, nick: user.nickname, userId: user.id, changes: diffs
      }));

      return interaction.editReply(`✅ ${reserve ? 'Set' : 'Unset'} **reserve** for **${nickname}**.`);
    }

    if (sub === 'unregister') {
      if (!row) return interaction.editReply(`User **${nickname}** is not registered in **${event.name}**.`);

      await row.destroy();
      await scheduleParticipantListUpdate(client, eventId);

      logActivity(client, `User **${user.nickname}** was **removed** from **${event.name}** by [ **${interaction.user.tag}** ]`);
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
