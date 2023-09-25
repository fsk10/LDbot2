const { SlashCommandBuilder } = require('@discordjs/builders');
const { Op } = require('sequelize');
const { updateEvent, updateUser, updateEventUser } = require('../../database/operations');
const { listEvents, listUsers } = require('../../database/operations');
const { UserModel, EventModel } = require('../../models');
const logActivity = require('../../utils/logActivity');
const { isAdmin } = require('../../utils/permissions');
const logger = require('../../utils/logger');

const commandData = new SlashCommandBuilder()
    .setName('adminedit')
    .setDescription('Edit events, users, or event-specific user properties')
    .addSubcommand(subcommand => 
        subcommand.setName('event')
            .setDescription('Edit event properties')
            .addStringOption(option => option.setName('eventname').setDescription('Name of the event to edit').setRequired(true).setAutocomplete(true))
            .addStringOption(option => option.setName('name').setDescription('Name for the event (restart bot after change)'))
            .addStringOption(option => option.setName('location').setDescription('Location for the event'))
            .addStringOption(option => option.setName('startdate').setDescription('Start date and time of the event (Format: YYYY-MM-DD HH:mm)'))
            .addStringOption(option => option.setName('enddate').setDescription('End date and time of the event (Format: YYYY-MM-DD HH:mm)'))
            .addIntegerOption(option => option.setName('seatsavailable').setDescription('Number of available seats'))
            .addNumberOption(option => option.setName('entryfee').setDescription('Entry fee for the event'))
            .addStringOption(option => option.setName('participantchannel').setDescription('Participant channel for the event'))
    )
    .addSubcommand(subcommand => 
        subcommand.setName('user')
            .setDescription('Edit general user properties')
            .addStringOption(option => option.setName('nickname').setDescription('Nickname of the user to edit').setRequired(true).setAutocomplete(true))
            .addStringOption(option => option.setName('newnickname').setDescription('New nickname for the user'))
            .addStringOption(option => option.setName('firstname').setDescription('First name for the user'))
            .addStringOption(option => option.setName('lastname').setDescription('Last name for the user'))
            .addStringOption(option => option.setName('country').setDescription('Country for the user (two-letter country code)').setAutocomplete(true))
            .addStringOption(option => option.setName('email').setDescription('Email for the user'))
    )
    .addSubcommand(subcommand => 
        subcommand.setName('eventuser')
            .setDescription('Edit event-specific user properties')
            .addStringOption(option => option.setName('event').setDescription('Event for the user to edit').setRequired(true).setAutocomplete(true))
            .addStringOption(option => option.setName('nickname').setDescription('Nickname of the user to edit').setRequired(true).setAutocomplete(true))
            .addIntegerOption(option => option.setName('seat').setDescription('Seat number for the user'))
            .addBooleanOption(option => option.setName('haspaid').setDescription('Has the user paid?'))
    );


function isValidDateTime(dateTimeStr) {
    const regex = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
    if (!regex.test(dateTimeStr)) return false;

    const dateObj = new Date(dateTimeStr);
    if (dateObj.toString() === "Invalid Date") return false;

    return true;
}

async function prepare() {
    return commandData;
}

async function execute(interaction, client) {

    // Check if the user has admin permissions
	const userIsAdmin = await isAdmin(interaction);
        
	if (!userIsAdmin) {
		// Inform the user that they don't have the required permissions
		return interaction.reply({
			content: 'You don\'t have the required permissions to use this command.',
			ephemeral: true
		});
	}

    const subcommand = interaction.options.getSubcommand();

    try {
        if (subcommand === 'event') {
            const eventName = interaction.options.getString('eventname');
            const originalEventName = await EventModel.findOne({
                where: { id: eventName }
            });
            let updatedFields = {};

            // Extract the provided options and update the fields
            for (let field of ['name', 'location', 'startdate', 'enddate', 'seatsavailable', 'entryfee', 'participantchannel']) {
                const optionValue = interaction.options.get(field)?.value;
                if (optionValue !== undefined) {
                    updatedFields[field] = optionValue;
                }
            }

            const startDateStr = interaction.options.getString('startdate');
            const endDateStr = interaction.options.getString('enddate');

            // Check if the provided dates are in a valid format
            if (startDateStr && !isValidDateTime(startDateStr)) {
                return await interaction.reply({
                    content: 'Invalid start date-time format. Please use the format YYYY-MM-DD HH:mm.',
                    ephemeral: true
                });
            }
            if (endDateStr && !isValidDateTime(endDateStr)) {
                return await interaction.reply({
                    content: 'Invalid end date-time format. Please use the format YYYY-MM-DD HH:mm.',
                    ephemeral: true
                });
            }

            const result = await updateEvent(eventName, updatedFields, client);

            if (result.success) {
                logActivity(client, `Event **${originalEventName.name}** was updated by ${interaction.user.tag}`);
                await interaction.reply({
                    content: `Event **${originalEventName.name}** has been updated successfully!`,
                    ephemeral: true
                });
            } else {
                logger.error(`Error updating event: ${result.message || result.error}`);
                await interaction.reply({
                    content: `Error updating event: ${result.message || result.error}`,
                    ephemeral: true
                });
            }

        } else if (subcommand === 'user') {
            const nickname = interaction.options.getString('nickname');
            let updatedFields = {};

            // Handle the newnickname field separately
            const newNicknameValue = interaction.options.getString('newnickname');
            if (newNicknameValue !== null) {
                updatedFields['nickname'] = newNicknameValue;
            }

            // Extract the provided options and update the fields
            for (let field of ['firstname', 'lastname', 'country', 'email']) {
                const optionValue = interaction.options.get(field)?.value;
                if (optionValue !== undefined) {
                    updatedFields[field] = optionValue;
                }
            }
            
            const result = await updateUser(nickname, updatedFields, client);

            if (result.success) {
                logActivity(client, `User **${nickname}** was updated by ${interaction.user.tag}`);
                await interaction.reply({
                    content: `User **${nickname}** has been updated successfully!`,
                    ephemeral: true
                });
            } else {
                await interaction.reply({
                    content: `Error updating user: ${result.error}`,
                    ephemeral: true
                });
            }

        } else if (subcommand === 'eventuser') {
            const event = interaction.options.getString('event');
            const nickname = interaction.options.getString('nickname');
            let updatedFields = {};

            // Extract the provided options and update the fields
            for (let field of ['seat', 'haspaid']) {
                const optionValue = interaction.options.get(field)?.value;
                if (optionValue !== undefined) {
                    updatedFields[field] = optionValue;
                }
            }

            // Fetch the user's ID based on the provided nickname
            const user = await UserModel.findOne({ where: { nickname: { [Op.like]: nickname } } });

            if (!user) {
                logger.error(`No user found with the nickname: ${nickname}`);
                return await interaction.reply({
                    content: `No user found with the nickname: **${nickname}**.`,
                    ephemeral: true
                });
            }
            const userId = user.id;

            // Fetch the event's ID based on the provided event name
            const eventRecord = await EventModel.findOne({ where: { id: event } });
            if (!eventRecord) {
                logger.error(`No event found with the ID: ${event}`);
                return await interaction.reply({
                    content: `No event found with the ID: **${event}**.`,
                    ephemeral: true
                });
            }
            const currentEventId = eventRecord.id;

            // Now call the update function
            const result = await updateEventUser(currentEventId, userId, updatedFields, client);

            if (result.success) {
                logActivity(client, `User **${nickname}** was updated for **${eventRecord.name}** by ${interaction.user.tag}`);
                await interaction.reply({
                    content: `User **${nickname}**'s details for **${eventRecord.name}** have been updated successfully!`,
                    ephemeral: true
                });
            } else {
                logger.error("Error in /adminedit eventuser:", result.message || "Unknown error");
                await interaction.reply({
                    content: 'Error updating user-event details. Please try again.',
                    ephemeral: true
                });
            }
        }
    } catch (error) {
        logger.error("Error in /adminedit eventuser:", error);
        await interaction.reply({
            content: 'An error occurred. Please try again.',
            ephemeral: true
        });
    }
}   

module.exports = {
    data: commandData,
    execute,
    prepare
};
