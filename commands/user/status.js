const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { EventModel, UserModel, EventUsersModel } = require('../../models'); // <-- Added EventUsersModel
const { getAvailableSeatsForEvent } = require('../../database/operations');
const formatDisplayDate = require('../../utils/dateUtils');

const commandData = new SlashCommandBuilder()
    .setName('status')
    .setDescription('Display upcoming or running events and your registration status');

async function execute(interaction) {
    try {
        const userId = interaction.user.id;
        const user = await UserModel.findOne({ where: { discorduser: userId } });
        
        const events = await EventModel.findAll();
        const embeds = [];

        for (const event of events) {
            const seatsInfo = await getAvailableSeatsForEvent(event.id);

            let userRegistration;
            if (user) {
                userRegistration = await EventUsersModel.findOne({
                    where: { userId: user.id, eventId: event.id }
                });
            }

            const embed = new EmbedBuilder()
                .setTitle("Event & User Status")
                .setColor('#0089E4')
                .addFields(
                    { name: "`                  EVENT STATUS                   `", value: "** **" },
                    { name: event.name, value: event.location },
                    { name: ":calendar:  Starts", value: formatDisplayDate(event.startdate), inline: true },
                    { name: "** **", value: "** **", inline: true },
                    { name: ":calendar:  Ends", value: formatDisplayDate(event.enddate), inline: true },
                    { name: ":chair:  Seats available", value: `${seatsInfo.availableSeats} / ${seatsInfo.totalSeats}`, inline: true },
                    { name: "** **", value: "** **", inline: true },
                    { name: ":moneybag:  Entry Fee", value: `€${event.entryfee}`, inline: true }
                );

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
                

            embeds.push(embed);
        }

        interaction.reply({
            embeds: embeds,
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
