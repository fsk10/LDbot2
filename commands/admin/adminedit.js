const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { Op } = require('sequelize');
const { updateEvent, updateUser, updateEventUser, updateParticipantList, getAvailableSeatsForEvent } = require('../../database/operations');
const { UserModel, EventModel, EventUsersModel } = require('../../models');
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
            .addStringOption(option => option.setName('nickname').setDescription('Nickname of the user to edit').setRequired(true).setAutocomplete(false))
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
            .addStringOption(option => option.setName('nickname').setDescription('Nickname of the user to edit').setRequired(true).setAutocomplete(false))
            .addIntegerOption(option => option.setName('seat').setDescription('Seat number for the user'))
            .addBooleanOption(option => option.setName('haspaid').setDescription('Has the user paid?'))
            .addBooleanOption(option => option.setName('reserve').setDescription('Set the user as reserve'))
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
		const permissionErrorEmbed = new EmbedBuilder()
                .setTitle('Permission Denied')
                .setDescription("You don't have the required permissions to use this command.")
                .setColor('#FF0000'); // Red color for error

        return interaction.reply({ embeds: [permissionErrorEmbed], ephemeral: true });
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
                // Log the event update
                let logMessage = `Event **${originalEventName.name}** was updated by [ **${interaction.user.tag}** ].\n`;
                for (const [key, value] of Object.entries(updatedFields)) {
                    logMessage += `:white_small_square: ${key} = ${value} \n`;
                }
                logMessage = logMessage.slice(0, -2); // Remove the trailing comma and space
                logActivity(client, logMessage);
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
                // Log the user update
                let logMessage = `User **${nickname}** was updated by [ **${interaction.user.tag}** ].\n`;
                for (const [key, value] of Object.entries(updatedFields)) {
                    logMessage += `:white_small_square: ${key} = ${value} \n`;
                }
                logMessage = logMessage.slice(0, -2); // Remove the trailing comma and space
                logActivity(client, logMessage);
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

            // Fetch the current reserve status for the user
            const currentEventUser = await EventUsersModel.findOne({
                where: {
                    userId: userId,
                    eventId: currentEventId
                }
            });
            const currentReserveStatus = currentEventUser ? currentEventUser.reserve : null;
            const newReserveStatus = interaction.options.getBoolean('reserve');
            
            // Handle Reserve to Main Transition
            if (currentReserveStatus && !newReserveStatus) {

                // Check available seats for the event
                const seatCheck = await getAvailableSeatsForEvent(currentEventId);
                if (seatCheck.success && seatCheck.availableSeats === 0) {
                    // If the event is full, send an error message
                    return await interaction.reply({
                        content: `The event **${seatCheck.eventName}** is already full. Please remove a user from the main list before adding another.`,
                        ephemeral: true
                    });
                } else if (!seatCheck.success) {
                    logger.error(`Error checking available seats for event ${currentEventId}: ${seatCheck.error}`);
                    return await interaction.reply({
                        content: 'Error checking available seats for the event. Please try again.',
                        ephemeral: true
                    });
                }

                // User is being moved from reserve list to main list.
                const occupiedSeats = await EventUsersModel.findAll({
                    where: {
                        eventId: currentEventId,
                        reserve: false,
                        seat: { [Op.ne]: null }
                    },
                    attributes: ['seat'],
                    order: [['seat', 'ASC']]
                });

                let availableSeat = 1;

                occupiedSeats.forEach((seatObj, index) => {
                    if (seatObj.seat === availableSeat) {
                        availableSeat++;
                    }
                });

                updatedFields['seat'] = availableSeat;
                updatedFields['reserve'] = false;
            }

            // Handle Main to Reserve Transition
            if (!currentReserveStatus && newReserveStatus) {
                // User is being moved from main list to reserve list.
                updatedFields['seat'] = null; // Release the user's seat.
                updatedFields['reserve'] = true;
            }

            // Now call the update function
            const result = await updateEventUser(currentEventId, userId, updatedFields, client);

            if (result.success) {
                // Check for reserve status changes
                if (result.success) {
                    // Check for reserve status changes
                    if (currentReserveStatus && !newReserveStatus) { 
                        // Only when user was on the reserve list and now is on the main list
                        const discordUserId = user.discorduser;
                        const userToNotify = await client.users.fetch(discordUserId);

                        const embeds = createConfirmationEmbeds({
                            discorduser: userToNotify.username,
                            event: eventRecord.name,
                            nickname: user.nickname,
                            seat: updatedFields['seat'],
                            country: user.country,
                            firstname: user.firstname,
                            lastname: user.lastname,
                            email: user.email
                        });
                        
                        // Send the embeds to the user
                        await userToNotify.send({ embeds: embeds });

                    } else if (newReserveStatus) {
                        const movedToReserveEmbed = new EmbedBuilder()
                            .setTitle('You have been moved to the reserves list!')
                            .setDescription(`Event: **${eventRecord.name}**\n\nWe'll notify you if a seat becomes available again.`)
                            .setColor('#FFA500');

                            const discordUserId = user.discorduser;
                            const userToNotify = await client.users.fetch(discordUserId);
                            await userToNotify.send({ embeds: [movedToReserveEmbed] });
                    }
                
                    // Log the user event update
                    let logMessage = `User **${nickname}** was updated by [ **${interaction.user.tag}** ].\n`;
                    for (const [key, value] of Object.entries(updatedFields)) {
                        logMessage += `:white_small_square: ${key} = ${value} \n`;
                    }
                    logActivity(client, logMessage.trim()); // Use trim() to remove any trailing newline
                    await interaction.reply({
                        content: `User **${nickname}** has been updated successfully!`,
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
        }
    } catch (error) {
        logger.error("Error in /adminedit eventuser:", error);
        await interaction.reply({
            content: 'An error occurred. Please try again.',
            ephemeral: true
        });
    }
} 

function createConfirmationEmbeds(data) {
    const registrationEmbed = new EmbedBuilder()
    .setTitle(`Congratulations ${data.discorduser}!  :partying_face: :tada: \n\nYou have received a spot at **__${data.event}__**`)
    .setColor('#28B81C')
    .addFields(
        { name: "** **", value: "** **" },
        { name: "Nickname", value: data.nickname, inline: true },
        { name: "Assigned seat", value: data.seat ? data.seat.toString() : 'Not Assigned', inline: true },
        { name: "Country", value: `:flag_${data.country.toLowerCase()}:`, inline: true },
        { name: "** **", value: "** **" },
        { name: "Firstname", value: data.firstname, inline: true },
        { name: "Lastname", value: data.lastname, inline: true },
        { name: "E-mail address", value: data.email, inline: true },
    )
    .setFooter({ text: "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀" });

    const paymentDetailsEmbed = new EmbedBuilder()
        .setTitle("Payment details")
        .setDescription(":moneybag: You will **not** be added to the events participant list until you have paid the entry fee.\n\n:chair: Your seat will be reserved for __14 days__ and will then be made available for other participants to claim!\n\n:money_with_wings: You can receive a refund (in case of dropout) up until 60 days before the event start date.")
        .setColor('#28B81C')
        .addFields(
            { name: "** **", value: "** **" },
			{ name: "Paypal", value: "peter.hedman@mail.com", inline: true },
			{ name: "Revolut", value: "@peterj1cv", inline: true },
			{ name: "Swish [Only-swedes]", value: "0703835558", inline: true },
			{ name: "** **", value: "** **" },
			{ name: "Bank payment (Non-swedes)", value: "BIC: NDEASESS\nIBAN(SWIFT-address): SE9230000000008307147515" },
			{ name: "** **", value: "** **" },
			{ name: "Bank payment [Only-swedes]", value: "Bank: Nordea\nClearing number: 3300\nAccount number: 830714-7515" },
			{ name: "** **", value: "```\nMake sure that we receive the full sum of 30 EUR. \nIf you pay by PayPal make sure to send it to  \"Family and friends\" to avoid added fees.\n```" }
        )
        .setFooter({ text: "⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀" });

    return [registrationEmbed, paymentDetailsEmbed];
}

module.exports = {
    data: commandData,
    execute,
    prepare
};
