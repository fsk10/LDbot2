const { SlashCommandBuilder } = require('@discordjs/builders');
const { Op } = require('sequelize');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { UserModel, EventModel, EventUsersModel } = require('../../models');
const { listEvents, handleTempRegistration } = require('../../database/operations');
const logger = require('../../utils/logger');
const logActivity = require('../../utils/logActivity');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('register')
        .setDescription('Start the registration process.')
        .addStringOption(option => 
            option.setName('event')
                .setDescription('Event you want to register for')
                .setRequired(true)
                .setAutocomplete(true)
        ),
        
    async execute(interaction) {
        const discorduser = interaction.user.id;
        const eventName = interaction.options.getString('event');
        const events = await listEvents({ all: true });
        const eventId = parseInt(interaction.options.getString('event'), 10);
        const eventExists = events.some(e => e.id === eventId);
        let user;
        try {
            user = await UserModel.findOne({ where: { discorduser: discorduser } });
        } catch (error) {
            logger.error("Error fetching user:", error);
        }

        // Check if the event exists in the database
        if (!eventExists) {
            await interaction.reply({
                content: "Invalid event. Please select a valid event to register for.",
                ephemeral: true
            });
            return;
        }

        // Check if the user is already registered for the event
        let isUserRegisteredForEvent = false;

        if (user) {
            isUserRegisteredForEvent = await EventUsersModel.findOne({ where: { userId: user.id, eventId: eventId } });
        } 

        // Determine if the event is full or not
        const registeredUsersForEvent = await EventUsersModel.count({ 
            where: { 
                eventId: eventId, 
                reserve: false,
                ...(user && isUserRegisteredForEvent ? { userId: { [Op.ne]: user.id } } : {}) // Exclude current user from the count if they're editing 
            } 
        });

        let eventDetails = await EventModel.findByPk(eventId);
        const maxSeats = eventDetails.seats;
        let isReserve = false;

        if (registeredUsersForEvent >= maxSeats) {
            isReserve = true;
        }

        if (isUserRegisteredForEvent) {
            eventDetails = await EventModel.findOne({ where: { id: eventId } });
            await handleTempRegistration(interaction, 'editingExistingRegistration', eventName, eventId, user);          
        
            try {
                // Create the embed with the user's current registration details
                const currentDetailsEmbed = new EmbedBuilder()
                    .setTitle(`Current Event Registration`)
                    .setDescription(`**Event:**\n${eventDetails.name}`)
                    .setColor('#FFA500')
                    .addFields(
                        { name: 'Nickname', value: user.nickname },
                        { name: 'Firstname', value: user.firstname },
                        { name: 'Lastname', value: user.lastname },
                        { name: 'Email', value: user.email },
                        { name: 'Country', value: `:flag_${user.country.toLowerCase()}:` },
                        { name: 'Seat', value: isUserRegisteredForEvent.seat ? isUserRegisteredForEvent.seat.toString() : 'Not assigned' }
                    )
                    .setFooter({ text: 'Please confirm or edit your details.' });
        
                // Create buttons for editing or confirming
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('registration_confirm')
                            .setLabel('No Changes')
                            .setStyle(3),
                        new ButtonBuilder()
                            .setCustomId('registration_edit')
                            .setLabel('Edit Registration')
                            .setStyle(1)
                    );
        
                await interaction.user.send({ embeds: [currentDetailsEmbed], components: [row] });
            } catch (error) {
                logger.error("Error sending embed and buttons in 'editingExistingRegistration':", error);
            }

            const regCheckDMsEmbed = new EmbedBuilder()
                .setTitle('Manage Your Registration')
                .setDescription(`Go to your DMs to manage your registration for event\n**${eventDetails.name}**`)
                .setColor('#0089E4');
            await interaction.reply({ embeds: [regCheckDMsEmbed], ephemeral: true });

            return;
        }               
        else if (user) {
            const eventDetails = await EventModel.findOne({ where: { id: eventId } });
            const actualEventName = eventDetails.name;

            const regAlreadyRegEmbed = new EmbedBuilder()
                .setTitle('Account Already Exists')
                .setDescription(`You already have an account registered in the bot database, but you have **NOT YET SIGNED UP** for the event **${actualEventName}**.`)
                .setColor('#FFA500')
                .addFields(
                    { name: 'Nickname', value: user.nickname, inline: true },
                    { name: 'Firstname', value: user.firstname, inline: true },
                    { name: 'Lastname', value: user.lastname, inline: true },
                    { name: 'Email', value: user.email, inline: true },
                    { name: 'Country', value: `:flag_${user.country.toLowerCase()}:`, inline: true },
                    { name: '** **', value: `** **`, inline: true },
                    { name: '** **', value: `** **`, inline: true },
                    { name: 'You now only need to provide your preferred seats to signup for the event:', value: `(Formated as a comma-separated list e.g. 3,11,29,..)` }
                )
                .setFooter({ text: 'You can stop/abort your registration at any time by typing !abort' });

            await interaction.user.send({ embeds: [regAlreadyRegEmbed] });
            
            // Check if there's an existing temporary registration for the user and update/create as necessary
            await handleTempRegistration(interaction, 'collectingPreferredSeats', eventName, eventId, user);
        }
        else {
            const eventDetails = await EventModel.findOne({ where: { id: eventId } });
            const actualEventName = eventDetails.name;

            const regProcessEmbed = new EmbedBuilder()
                .setTitle(`You are now registering for the event **__${actualEventName}__**`)
                .setDescription('Please fill in the user and event registration details below. \n\nYou can stop/abort your registration at any time by typing **!abort**\n You will also be able to edit your responses at the end of the registration phase before you submit your registration.')
                .setColor('#28B81C');
            await interaction.user.send({ embeds: [regProcessEmbed] });

            const regNicknameEmbed = new EmbedBuilder()
                .setTitle('Nickname')
                .setDescription('Please provide your nickname.')
                .setColor('#0089E4');
            await interaction.user.send({ embeds: [regNicknameEmbed] });
        
            // Check if there's an existing temporary registration for the user and update/create as necessary
            await handleTempRegistration(interaction, 'collectingNickname', eventName, eventId);
        }        

        const regCheckDMsEmbed = new EmbedBuilder()
            .setTitle('Register for Event')
            .setDescription(`Go to your DMs to continue the registration for event\n**${eventDetails.name}**`)
            .setColor('#0089E4');
        await interaction.reply({ embeds: [regCheckDMsEmbed], ephemeral: true });
    }
};