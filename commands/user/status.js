// commands/user/status.js
const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { Op } = require('sequelize');
const { EventModel, UserModel, EventUsersModel } = require('../../models');
const { getAvailableSeatsForEvent } = require('../../database/operations');
const formatDisplayDate = require('../../utils/dateUtils');

const commandData = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Display upcoming or running events and your registration status');

async function execute(interaction) {
  try {
    const now = new Date();

    // 🔹 Only ACTIVE events:
    // - If enddate exists: include when enddate >= now (ongoing or future)
    // - If enddate is null: include only if startdate >= now (future)
    const events = await EventModel.findAll({
      where: {
        [Op.or]: [
          { enddate: { [Op.gte]: now } },
          { enddate: null, startdate: { [Op.gte]: now } },
        ],
      },
      order: [['startdate', 'ASC']],
    });

    if (!events || events.length === 0) {
      return interaction.reply({
        content: 'There are no active events right now.',
        ephemeral: true,
      });
    }

    const userId = interaction.user.id;
    const user = await UserModel.findOne({ where: { discorduser: userId } });

    const embeds = [];

    for (const event of events) {
      const seatsInfo = await getAvailableSeatsForEvent(event.id);
      const available = seatsInfo?.success ? seatsInfo.availableSeats : '—';
      const total     = seatsInfo?.success ? seatsInfo.totalSeats     : '—';

      const regLabel = event.regopen ? 'Open' : 'Closed';

      const embed = new EmbedBuilder()
        .setTitle("Event & User Status")
        .setColor('#0089E4')
        .addFields(
          { name: "`                  EVENT STATUS                   `", value: "** **" },
          { name: event.name, value: event.location || 'TBA', inline: true },
          { name: "** **", value: "** **", inline: true },
          { name: "📝 Registration", value: `${regLabel}`, inline: true },
          { name: ":calendar:  Starts", value: formatDisplayDate(event.startdate), inline: true },
          { name: "** **", value: "** **", inline: true },
          { name: ":calendar:  Ends", value: formatDisplayDate(event.enddate), inline: true },

          // 👇 keep your spacing/ordering; just add Registration status
          { name: ":chair:  Seats available", value: `${available} / ${total}`, inline: true },
          { name: "** **", value: "** **", inline: true },
          { name: "💶 Entry Fee", value: `€${event.entryfee}`, inline: true }
        );

      if (user) {
        const userRegistration = await EventUsersModel.findOne({
          where: { userId: user.id, eventId: event.id }
        });

        if (userRegistration) {
          const paymentStatus = userRegistration.haspaid ? 'Paid' : 'Pending';
          const registrationStatus = userRegistration.reserve ? 'Reserve' : 'Registered';
          embed.addFields(
            { name: "`                  USER STATUS                   `", value: "** **" },
            { name: ":pencil:  Registration status", value: `${registrationStatus} (${paymentStatus})`, inline: true },
            { name: "** **", value: "** **", inline: true },
            { name: ":seat:  Seat", value: userRegistration.seat ? `#${userRegistration.seat}` : 'Not assigned', inline: true }
          );
        }
      }

      embeds.push(embed);
    }

    interaction.reply({
      embeds,
      ephemeral: true
    });

  } catch (error) {
    console.error(`Error executing /status: ${error.message}`);
    interaction.reply({ content: 'An error occurred while fetching status.', ephemeral: true });
  }
}

module.exports = {
  data: commandData,
  execute
};
