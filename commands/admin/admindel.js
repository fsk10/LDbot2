const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js'); // <-- you were missing this
const { isAdmin } = require('../../utils/permissions');
const { deleteEvent, deleteUserFromEvent, listEvents, listUsers, deleteUserCompletely } = require('../../database/operations');
const logActivity = require('../../utils/logActivity');

const commandData = new SlashCommandBuilder()
  .setName('admindel')
  .setDescription('Delete events or user from an event')
  .addSubcommand(sub =>
    sub.setName('event')
      .setDescription('Delete an event')
      .addStringOption(o =>
        o.setName('eventname')
          .setDescription('Event to delete')
          .setRequired(true)
          .setAutocomplete(true)
      ))
  .addSubcommand(sub =>
    sub.setName('user')
      .setDescription('Delete a user from an event (or delete the user entirely if no event provided)')
      .addStringOption(o =>
        o.setName('nickname')
          .setDescription('User nickname')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(o =>
        o.setName('eventname')
          .setDescription('Event (optional; if omitted, the user is deleted entirely)')
          .setRequired(false)
          .setAutocomplete(true)
      )
  );

async function execute(interaction, client) {
  try {
    // permissions first
    const userIsAdmin = await isAdmin(interaction);
    if (!userIsAdmin) {
      const emb = new EmbedBuilder()
        .setTitle('Permission Denied')
        .setDescription("You don't have the required permissions to use this command.")
        .setColor('#FF0000');
      return interaction.reply({ embeds: [emb], ephemeral: true });
    }

    // defer to avoid the 3s timeout
    await interaction.deferReply({ ephemeral: true });

    const sub = interaction.options.getSubcommand();

    if (sub === 'event') {
      // NOTE: autocomplete returns the event *ID* as value
      const eventIdStr = interaction.options.getString('eventname', true);
      const result = await deleteEvent(eventIdStr);

      if (result.success) {
        logActivity(client, `Event **${result.eventName}** has been deleted by [ **${interaction.user.tag}** ]`);
        return interaction.editReply(`✅ Event **${result.eventName}** has been deleted.`);
      } else {
        return interaction.editReply(`❌ ${result.error || 'Failed to delete event.'}`);
      }
    }

    if (sub === 'user') {
      const nickname = interaction.options.getString('nickname', true);
      const eventIdStr = interaction.options.getString('eventname'); // optional

      if (eventIdStr) {
        const result = await deleteUserFromEvent(nickname, eventIdStr, client);
        if (result.success) {
          logActivity(client, `User **${nickname}** has been removed from **${result.eventName}** by [ **${interaction.user.tag}** ]`);
          return interaction.editReply(`✅ User **${nickname}** has been removed from **${result.eventName}**.`);
        } else {
          return interaction.editReply(`❌ ${result.error || 'Failed to remove user from event.'}`);
        }
      } else {
        const result = await deleteUserCompletely(nickname, client);
        if (result.success) {
          logActivity(client, `User **${nickname}** has been completely deleted by [ **${interaction.user.tag}** ]`);
          return interaction.editReply(`✅ User **${nickname}** has been completely deleted.`);
        } else {
          return interaction.editReply(`❌ ${result.error || 'Failed to delete user.'}`);
        }
      }
    }

    return interaction.editReply('Unknown subcommand.');
  } catch (err) {
    // last-resort safety
    const msg = err?.message || String(err);
    try {
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(`❌ Error: ${msg}`);
      } else {
        await interaction.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
      }
    } catch {}
  }
}

async function prepare() {
  // (choices are provided by your global autocomplete; nothing to do here)
  return commandData;
}

module.exports = {
  data: commandData,
  execute,
  prepare,
};
