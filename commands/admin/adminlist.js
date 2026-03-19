const { SlashCommandBuilder } = require('@discordjs/builders');
const { listUsers, listEvents } = require('../../database/operations');
const { EmbedBuilder } = require('discord.js');
const { isAdmin } = require('../../utils/permissions');
const formatDisplayDate = require('../../utils/dateUtils');
const { EventModel } = require('../../models');
const { getNameFromID } = require('../../utils/getNameFromID');

const commandData = new SlashCommandBuilder()
  .setName('adminlist')
  .setDescription('List events or users')
  .addSubcommand(subcommand =>
    subcommand.setName('users')
      .setDescription('List all users')
      .addStringOption(o =>
        o.setName('event')
          .setDescription('Select an event')
          .setAutocomplete(true)   // live autocomplete; no choices anywhere
          .setRequired(false)
      )
      .addStringOption(o =>
        o.setName('output')
          .setDescription('Output format: full or short')
          .setRequired(false)
          .addChoices(
            { name: 'Short', value: 'short' },
            { name: 'Full',  value: 'full'  }
          )
      )
  )
  .addSubcommand(subcommand =>
    subcommand.setName('events')
      .setDescription('List all events')
      .addBooleanOption(o =>
        o.setName('all')
          .setDescription('Show all events including archived')
          .setRequired(false)
      )
      .addBooleanOption(o =>
        o.setName('archived')
          .setDescription('Show only archived events')
          .setRequired(false)
      )
  );

async function splitEmbeds(users, eventName, interaction, outputType = 'short', allUsers = false) {
  const MAX_SIZE = 4096;

  const embeds = [];
  let currentEmbedDescription = '​'; // zero-width char to keep nice spacing with empty top
  let charCount = currentEmbedDescription.length;

  // Safe resolver for Discord display name
  async function safeDiscordName(discordUserId) {
    try {
      const nameResult = await getNameFromID(interaction, discordUserId);
      return (nameResult && nameResult.type === 'user' && nameResult.name) ? `${nameResult.name}` : 'Unknown';
    } catch {
      return 'Unknown';
    }
  }

  for (const user of (users || [])) {
    // Defensive reads
    const country = (user?.country || 'xx').toLowerCase(); // fallback flag if missing
    const nickname = user?.nickname || '(no nickname)';
    const first = user?.firstname || '';
    const last = user?.lastname || '';
    const email = user?.email || '';
    const discordId = user?.discorduser || '';
    const discordName = await safeDiscordName(discordId);

    const eu = user?.events?.[0]?.EventUsers;
    const seat = eu?.seat ?? 'N/A';
    const haspaid = Boolean(eu?.haspaid);
    const reserve = Boolean(eu?.reserve);
    const seatInfo = (seat && seat !== 'N/A') ? `Seat: ${seat}\n` : '';

    const notPaidIndicator = (!haspaid && !reserve) ? ' :small_orange_diamond:' : '';
    const reserveIndicator = reserve ? ' :small_red_triangle:' : '';
    const flag = `:flag_${country}:`;

    let userInfo;
    if (allUsers) {
      if (outputType === 'short') {
        userInfo = `${flag} **${nickname}** (${discordName})${reserveIndicator}${notPaidIndicator}\n`;
      } else {
        const eventList = (user?.events || [])
          .map(e => `:white_small_square: ${e?.name || '(unnamed event)'}`)
          .join('\n');
        userInfo =
          `**${nickname}**\n` +
          `User ID: ${user?.id ?? ''}\n` +
          `Discord Name: ${discordName}\n` +
          `Discord ID: ${discordId}\n` +
          `Full Name: ${first} ${last}\n` +
          `Email: ${email}\n` +
          `Country: ${flag}\n` +
          `In Event(s):\n${eventList}\n\n`;
      }
    } else {
      if (outputType === 'short') {
        const seatText = (!reserve && seat !== 'N/A') ? `[#${seat}]` : '';
        userInfo = `${flag} **${nickname}** (${discordName}) ${seatText}${reserveIndicator}${notPaidIndicator}\n`;
      } else {
        userInfo =
          `**${nickname}**\n` +
          `User ID: ${user?.id ?? ''}\n` +
          `Discord Name: ${discordName}\n` +
          `Discord ID: ${discordId}\n` +
          `Reserve: ${reserve ? 'Yes' : 'No'}\n` +
          `${seatInfo}Paid: ${haspaid ? 'Yes' : 'No'}\n` +
          `Full Name: ${first} ${last}\n` +
          `Email: ${email}\n` +
          `Country: ${flag}\n\n`;
      }
    }

    if (charCount + userInfo.length > MAX_SIZE) {
      embeds.push(
        new EmbedBuilder()
          .setTitle('User List')
          .setDescription(currentEmbedDescription)
          .setColor('#0089E4')
      );
      currentEmbedDescription = '​';
      charCount = currentEmbedDescription.length;
    }

    currentEmbedDescription += userInfo;
    charCount += userInfo.length;
  }

  if (charCount > 0) {
    embeds.push(
      new EmbedBuilder()
        .setTitle(`User List (${eventName})`)
        .setDescription(`:small_red_triangle: Reserve :small_orange_diamond: Unpaid entry fee\n\n${currentEmbedDescription}`)
        .setColor('#0089E4')
    );
  }

  return embeds;
}

async function execute(interaction) {
  // 1) Permission check
  const userIsAdmin = await isAdmin(interaction);
  if (!userIsAdmin) {
    const permissionErrorEmbed = new EmbedBuilder()
      .setTitle('Permission Denied')
      .setDescription("You don't have the required permissions to use this command.")
      .setColor('#FF0000');
    return interaction.reply({ embeds: [permissionErrorEmbed], ephemeral: true });
  }

  // 2) Defer ONCE here so both subcommands share the same lifecycle
  await interaction.deferReply({ ephemeral: true });

  const subcommand = interaction.options.getSubcommand();

  if (subcommand === 'users') {
    const eventId = interaction.options.getString('event');
    const outputType = interaction.options.getString('output') || 'short';

    const users = await listUsers(eventId);

    let eventName = 'All Users';
    let allUsers = false;
    if (eventId) {
      const event = await EventModel.findOne({ where: { id: eventId } });
      eventName = event ? event.name : 'Unknown Event';
    } else {
      allUsers = true;
    }

    const userEmbeds = await splitEmbeds(users, eventName, interaction, outputType, allUsers);

    if (!userEmbeds.length) {
      return interaction.editReply({ content: 'No users found.' });
    }

    // First page replaces the deferred reply
    await interaction.editReply({ embeds: [userEmbeds[0]] });

    // Overflow pages as follow-ups (still ephemeral)
    for (let i = 1; i < userEmbeds.length; i++) {
      await interaction.followUp({ embeds: [userEmbeds[i]], ephemeral: true });
    }

  } else if (subcommand === 'events') {
    const showAll = interaction.options.getBoolean('all');
    const archivedOnly = interaction.options.getBoolean('archived');

    const events = await listEvents({ all: showAll, archived: archivedOnly });

    const embed = new EmbedBuilder()
      .setTitle('List of Events')
      .setColor('#0089E4');

    events.forEach(event => {
      const formattedStartDate = formatDisplayDate(event.startdate);
      const formattedEndDate = formatDisplayDate(event.enddate);
      embed.addFields({
        name: event.name,
        value:
          `Event ID: ${event.id}\n` +
          `Location: ${event.location}\n` +
          `Start Date: ${formattedStartDate}\n` +
          `End Date: ${formattedEndDate}\n` +
          `Seats: ${event.seatsavailable}\n` +
          `Entry Fee: €${event.entryfee}\n` +
          `Participant Channel: ${event.participantchannel}`
      });
    });

    await interaction.editReply({ embeds: [embed] });
  }
}

async function prepare() {
  // With autocomplete enabled for the 'event' option, we must NOT attach choices here.
  // Keeping prepare() in case your deploy script expects it.
  return commandData;
}

module.exports = {
  data: commandData,
  execute,
  prepare
};
