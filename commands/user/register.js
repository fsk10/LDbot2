const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { UserModel, EventModel, EventUsersModel, TemporaryRegistration } = require('../../models');
const { listEvents } = require('../../database/operations');
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
        const user = await UserModel.findOne({ where: { discorduser: discorduser } });
        const eventName = interaction.options.getString('event');
        const events = await listEvents({ all: true });
        const eventId = parseInt(interaction.options.getString('event'), 10);
        const eventExists = events.some(e => e.id === eventId);

        // Check if the event exists in the database
        if (!eventExists) {
            await interaction.reply({
                content: "Invalid event. Please select a valid event to register for.",
                ephemeral: true
            });
            return;
        }

        let isUserRegisteredForEvent = false;

        if (user) {
            isUserRegisteredForEvent = await EventUsersModel.findOne({ where: { userId: user.id, eventId: eventId } });
        }

        if (isUserRegisteredForEvent) {
            const eventDetails = await EventModel.findOne({ where: { id: eventId } });

            await TemporaryRegistration.create({
                discorduser: interaction.user.id,
                stage: 'editingExistingRegistration',
                eventId: eventId,
                eventName: eventDetails.name,
                nickname: user.nickname,
                firstname: user.firstname,
                lastname: user.lastname,
                email: user.email,
                country: user.country,
                seat: isUserRegisteredForEvent.seat.toString()
            });            
        
            try {
                // Create the embed with the user's current registration details
                const currentDetailsEmbed = new EmbedBuilder()
                    .setTitle(`Current Event Registration`)
                    .setDescription(`**Event:** ${eventDetails.name}`)
                    .setColor(0x00AE86)
                    .addFields(
                        { name: 'Nickname', value: user.nickname },
                        { name: 'Firstname', value: user.firstname },
                        { name: 'Lastname', value: user.lastname },
                        { name: 'Email', value: user.email },
                        { name: 'Country', value: `:flag_${user.country.toLowerCase()}:` },
                        { name: 'Seat', value: isUserRegisteredForEvent.seat.toString() }
                    )
                    .setFooter({ text: 'Please confirm or edit your details.' })
                    .setTimestamp();
        
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
                console.error("Error sending embed and buttons in 'editingExistingRegistration':", error);
            }

            const regCheckDMsEmbed = new EmbedBuilder()
                .setTitle('Please check your DMs to manage your registration')
                .setColor('#2dcc20');
            await interaction.reply({ embeds: [regCheckDMsEmbed], ephemeral: true });

            return;
        }               
        else if (user) {
            const eventDetails = await EventModel.findOne({ where: { id: eventId } });
            const actualEventName = eventDetails.name;

            const regAlreadyRegEmbed = new EmbedBuilder()
                .setTitle('Account Already Exists')
                .setDescription(`You already have your account registered in the bot database, but are __not yet signed up__ for the event **${actualEventName}**.`)
                .setColor('#2dcc20')
                .addFields(
                    { name: 'Nickname', value: user.nickname, inline: true },
                    { name: 'Firstname', value: user.firstname, inline: true },
                    { name: 'Lastname', value: user.lastname, inline: true },
                    { name: 'Email', value: user.email, inline: true },
                    { name: 'Country', value: `:flag_${user.country.toLowerCase()}:`, inline: true },
                    { name: '** **', value: `** **`, inline: true },
                    { name: '** **', value: `** **`, inline: true },
                    { name: 'You now only need to provide your preferred seats (comma-separated list e.g. 3,11,29,...) to signup for the event:', value: `** **` }
                );
            await interaction.user.send({ embeds: [regAlreadyRegEmbed] });
            
            // Check if there's an existing temporary registration for the user and update/create as necessary
            const existingTempReg = await TemporaryRegistration.findOne({ where: { discorduser: interaction.user.id } });
        
            if (existingTempReg) {
                await existingTempReg.update({
                    stage: 'collectingPreferredSeats',
                    event: eventName,
                    eventId: eventId,
                    discorduser: interaction.user.id,
                    nickname: user.nickname,
                    firstname: user.firstname,
                    lastname: user.lastname,
                    email: user.email,
                    country: user.country
                });
            } else {
                await TemporaryRegistration.create({
                    stage: 'collectingPreferredSeats',
                    event: eventName,
                    eventId: eventId,
                    discorduser: interaction.user.id,
                    nickname: user.nickname,
                    firstname: user.firstname,
                    lastname: user.lastname,
                    email: user.email,
                    country: user.country
                });
            }
        }
        else {
            const eventDetails = await EventModel.findOne({ where: { id: eventId } });
            const actualEventName = eventDetails.name;

            const regProcessEmbed = new EmbedBuilder()
                .setTitle(`You are now registering for the event **__${actualEventName}__**`)
                .setDescription('Please fill in the user and event registration details below. \n\nYou can stop/abort your registration at any time by typing **!abort**. \n You will also be able to edit your responses at the end of the registration phase before you submit your registration.')
                .setColor('#0099ff');
            await interaction.user.send({ embeds: [regProcessEmbed] });

            const regNicknameEmbed = new EmbedBuilder()
                .setTitle('Nickname')
                .setDescription('Please provide your nickname.')
                .setColor('#2dcc20');
            await interaction.user.send({ embeds: [regNicknameEmbed] });
        
            // Check if there's an existing temporary registration for the user and update/create as necessary
            const existingTempReg = await TemporaryRegistration.findOne({ where: { discorduser: interaction.user.id } });
        
            if (existingTempReg) {
                await existingTempReg.update({
                    stage: 'collectingNickname',
                    event: eventName,
                    eventId: eventId,
                    discorduser: interaction.user.id
                });
            } else {
                await TemporaryRegistration.create({
                    stage: 'collectingNickname',
                    event: eventName,
                    eventId: eventId,
                    discorduser: interaction.user.id
                });
            }
        }        

        const regCheckDMsEmbed = new EmbedBuilder()
            .setTitle('Please check your DMs to manage your registration')
            .setColor('#2dcc20');
        await interaction.reply({ embeds: [regCheckDMsEmbed], ephemeral: true });
    }
};
