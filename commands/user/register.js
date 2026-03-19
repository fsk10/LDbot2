const { SlashCommandBuilder } = require('@discordjs/builders');
const { Op } = require('sequelize');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { UserModel, EventModel, EventUsersModel, TemporaryRegistration } = require('../../models');
const { listEvents, handleTempRegistration } = require('../../database/operations');
const logger = require('../../utils/logger');
const logActivity = require('../../utils/logActivity');
const { getRegistrationSnapshot } = require('../../utils/registrationData');
const { buildCurrentRegistrationEmbed, buildManageRegistrationButtons, buildAlreadyRegisteredNotice, buildAccountExistsEmbed } = require('../../utils/embeds');

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
        if (!interaction.deferred && !interaction.replied) {
            await interaction.deferReply({ ephemeral: true }).catch(() => {});
        }

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

        if (isUserRegisteredForEvent) {
            // 1) Load the event row
            const eventDetails = await EventModel.findOne({ where: { id: eventId } });

            // 2) Store lightweight context so the new buttons work
            await TemporaryRegistration.upsert({
                discorduser: interaction.user.id,
                eventId,
                event: eventDetails.name,
                stage: 'manageExisting',
            });

            // 3) Build and DM the unified “Current Event Registration” card (with seat / reserve)
            const snap = await getRegistrationSnapshot(interaction.user.id);
            const existing = await EventUsersModel.findOne({ where: { userId: user.id, eventId } });

            const dmEmbed = buildCurrentRegistrationEmbed({
                eventName: eventDetails.name,
                discordUsername: interaction.user.username,
                userSnap: snap,
                seat: existing?.seat || null,
                isReserve: !!existing?.reserve,
            });
            const dmButtons = buildManageRegistrationButtons();

            try {
                await interaction.user.send({ embeds: [dmEmbed], components: [dmButtons] });
            } catch (error) {
                logger.error("Error sending current-registration DM:", error);
            }

            // 4) Ephemeral “go to DMs” notice in the guild
            const regCheckDMsEmbed = buildAlreadyRegisteredNotice({ eventName: eventDetails.name });
            await interaction.editReply({ embeds: [regCheckDMsEmbed] });
            return;
        }     
        else if (user) {
            // Show the unified “Account exists” card via builder (uses account_confirm button)
            const eventDetails = await EventModel.findOne({ where: { id: eventId } });

            // Seed a temp row so the button handlers know which event we’re working on
            await TemporaryRegistration.upsert({
                discorduser: interaction.user.id,
                eventId,
                event: eventDetails.name,
                nickname: user.nickname,
                firstname: user.firstname,
                lastname: user.lastname,
                email: user.email,
                country: user.country,
                stage: 'showingAccountConfirm',
            });

            const snap = await getRegistrationSnapshot(interaction.user.id);
            const { embed, row } = buildAccountExistsEmbed({
                eventName: eventDetails.name,
                snap,
                discordUsername: interaction.user.username,
            });

            try {
                await interaction.user.send({ embeds: [embed], components: [row] });
            } catch (err) {
                logger.error('Error DMing account-exists card:', err);
            }

            // Tell the user to check DMs (we already deferred)
            await interaction.editReply({
                embeds: [{
                title: 'Registration',
                description: `Check your DMs to start registration for **${eventDetails.name}**.`,
                color: 0x28B81C
                }]
            });
            return;
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
        await interaction.editReply({ embeds: [regCheckDMsEmbed] });
    }
};