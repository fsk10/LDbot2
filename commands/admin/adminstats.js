const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { isAdmin } = require('../../utils/permissions');
const { EventModel, EventUsersModel, UserModel } = require('../../models');
const { DateTime } = require('luxon');

const commandData = new SlashCommandBuilder()
  .setName('adminstats')
  .setDescription('Show statistics for an event.')
  .addStringOption(o =>
    o.setName('event')
      .setDescription('Select an event')
      .setAutocomplete(true)
      .setRequired(true)
  );

async function execute(interaction) {
  const userIsAdmin = await isAdmin(interaction);
  if (!userIsAdmin) {
    const permEmbed = new EmbedBuilder()
      .setTitle('Permission Denied')
      .setDescription("You don't have the required permissions to use this command.")
      .setColor('#FF0000');
    return interaction.reply({ embeds: [permEmbed], ephemeral: true });
  }

  await interaction.deferReply({ ephemeral: true });

  const eventId = interaction.options.getString('event');
  const event = await EventModel.findByPk(eventId);
  if (!event) {
    return interaction.editReply({ content: 'Event not found.' });
  }

  const [totalMain, paid, reserve] = await Promise.all([
    EventUsersModel.count({ where: { eventId, reserve: false } }),
    EventUsersModel.count({ where: { eventId, haspaid: true, reserve: false } }),
    EventUsersModel.count({ where: { eventId, reserve: true } }),
  ]);

  const unpaid = totalMain - paid;
  const capacity = event.seatsavailable || 0;
  const payPercent = totalMain > 0 ? Math.round((paid / totalMain) * 100) : 0;

  const now = DateTime.now();
  const start = DateTime.fromJSDate(event.startdate);
  const daysLeft = Math.ceil(start.diff(now, 'days').days);
  const daysStr = daysLeft > 0 ? `${daysLeft}` : 'Event started';

  const sp = { name: '** **', value: '** **', inline: true };

  const statsEmbed = new EmbedBuilder()
    .setTitle('Stats')
    .setColor('#0089E4')
    .addFields(
      { name: event.name, value: '** **' },
      { name: '🪑 Seats',     value: `${totalMain} / ${capacity}`,           inline: true }, sp,
      { name: '👥 Reserve',   value: `${reserve}`,                           inline: true },
      { name: '💰 Paid',      value: `${paid} / ${totalMain} (${payPercent}%)`, inline: true }, sp,
      { name: '⏳ Unpaid',    value: `${unpaid}`,                            inline: true },
      { name: '📅 Days left', value: daysStr,                                inline: true }, sp,
      { name: '** **',        value: '** **',                                inline: true },
    );

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`stats_unpaid_${eventId}`)
      .setLabel('Show unpaid')
      .setStyle(2)
      .setDisabled(unpaid === 0),
    new ButtonBuilder()
      .setCustomId(`stats_reserve_${eventId}`)
      .setLabel('Show reserve')
      .setStyle(2)
      .setDisabled(reserve === 0),
  );

  await interaction.editReply({ embeds: [statsEmbed], components: [row] });
}

module.exports = { data: commandData.toJSON(), execute };
