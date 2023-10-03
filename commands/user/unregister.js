const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { EventModel, UserModel, EventUsersModel } = require('../../models');
const logger = require('../../utils/logger');
const logActivity = require('../../utils/logActivity');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('unregister')
        .setDescription('Unregister from an event')
        .addStringOption(option => 
            option.setName('event')
                .setDescription('The event to unregister from')
                .setRequired(true)
                .setAutocomplete(true)
        ),
    
    async execute(interaction) {
        try {
            const eventName = interaction.options.getString('event');
            const userId = interaction.user.id;

            if (eventName === "no_match") {
                return interaction.reply({
                    content: "No events found for you to unregister from.",
                    ephemeral: true
                });
            }

            // Fetch the user's details
            const user = await UserModel.findOne({ where: { discorduser: userId } });
            if (!user) {
                return interaction.reply({ content: 'You are not registered in our system.', ephemeral: true });
            }

            // Check if user is registered for the specified event
            const event = await EventModel.findOne({ where: { name: eventName } });
            if (!event) {
                return interaction.reply({ content: `The event "${eventName}" does not exist.`, ephemeral: true });
            }

            const userRegistration = await EventUsersModel.findOne({
                where: { userId: user.id, eventId: event.id }
            });

            if (!userRegistration) {
                return interaction.reply({ content: `You are not registered for the event "${eventName}".`, ephemeral: true });
            }

            const confirmCustomId = `confirm_unregistration-${eventName}`;
            const cancelCustomId = `cancel_unregistration-${eventName}`;

            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(confirmCustomId)
                        .setLabel('Yes')
                        .setStyle('4'),
                    new ButtonBuilder()
                        .setCustomId(cancelCustomId)
                        .setLabel('No')
                        .setStyle('2')
                );

            const embed = new EmbedBuilder()
            .setTitle("Unregister Confirmation")
            .setDescription(`Are you sure you want to remove your registration for **${eventName}**?`)
            .setColor("#FFA500");

        await interaction.reply({
            embeds: [embed],
            ephemeral: true,
            components: [row]
        });

        } catch (error) {
            logger.error(`Error executing /unregister: ${error.message}`);
            interaction.reply({ content: 'An error occurred while processing your request.', ephemeral: true });
        }
    }
};