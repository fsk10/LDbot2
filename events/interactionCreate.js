const { Events, EmbedBuilder } = require('discord.js');
const { Sequelize } = require('sequelize');
const { listEvents, listUsers, listEventsForUser, generateCurrentSeatingMap, updateParticipantList } = require('../database/operations');
const { UserModel, EventModel, EventUsersModel, TemporaryRegistration } = require('../models');
const logger = require('../utils/logger');
const countries = require('../config/countryList');

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {
		if (interaction.isChatInputCommand()) {
			const command = interaction.client.commands.get(interaction.commandName);

			if (!command) {
				logger.error(`No command matching ${interaction.commandName} was found.`);
				return;
			}

			try {
				await command.execute(interaction, interaction.client); 
			} catch (error) {
                console.error(`Error executing ${interaction.commandName}: ${error.message}`);
                if (error instanceof Sequelize.ValidationError) {
                    for (const validationErrorItem of error.errors) {
                        console.error(`Validation error on field ${validationErrorItem.path}: ${validationErrorItem.message}`);
                    }
                }
            }            

		} else if (interaction.isAutocomplete()) {
            const focusedOptionName = interaction.options.getFocused(true)?.name || "none";

            // Add more conditions for other commands and subcommands as needed
            switch (interaction.commandName) {
				case 'register':
					if (focusedOptionName === 'event') {
						await handleEventAutocomplete(interaction);
					}
					break;
                case 'adminadd':
                    if (interaction.options.getSubcommand() === 'user' && focusedOptionName === 'event') {
                        await handleEventAutocomplete(interaction);
                    }
                    break;
                case 'admindel':
                    if (interaction.options.getSubcommand() === 'event' && focusedOptionName === 'eventname') {
                        await handleEventAutocomplete(interaction);
                    } else if (interaction.options.getSubcommand() === 'user') {
                        if (focusedOptionName === 'nickname') {
                            await handleUserAutocomplete(interaction);
                        } else if (focusedOptionName === 'eventname') {
                            await handleUserEventAutocomplete(interaction);
                        }
                    }
                    break;
                case 'adminedit':
                    if (interaction.options.getSubcommand() === 'event' && (focusedOptionName === 'eventname' || focusedOptionName === 'eventuser')) {
                        await handleEventAutocomplete(interaction);
                    } else if (interaction.options.getSubcommand() === 'user' && focusedOptionName === 'nickname') {
                        await handleUserAutocomplete(interaction);
                    } else if (interaction.options.getSubcommand() === 'user' && focusedOptionName === 'country') {
						await handleCountryAutocomplete(interaction);
					} else if (interaction.options.getSubcommand() === 'eventuser') {
                        if (focusedOptionName === 'event') {
                            await handleEventAutocomplete(interaction);
                        } else if (focusedOptionName === 'nickname') {
                            await handleEventUserNicknameAutocomplete(interaction);
                        }
                    }
                    break;
            }
        }
		
		if (interaction.isButton()) {
			let userId = interaction.user.id;
			
            switch (interaction.customId) {
                case 'registration_confirm':
					// Clean up the ongoing registration data and send a feedback message
					await TemporaryRegistration.destroy({ where: { discorduser: userId } });
                    break;
            }

            // Check if the user exists in the ongoingRegistrations object
            const ongoingRegistration = await TemporaryRegistration.findOne({ where: { discorduser: userId } });
            
            if (!ongoingRegistration) {
                if (interaction.customId === 'registration_confirm') {
                    return interaction.reply({ content: 'No changes were made to your registration.', ephemeral: true });
                }
                return interaction.reply({ content: "You've already completed or cancelled the registration process.", ephemeral: true });
            }

            switch (interaction.customId) {
                case 'registration_cancel':
                    await TemporaryRegistration.destroy({ where: { discorduser: interaction.user.id } });
                    await interaction.reply({ content: 'Registration cancelled.', ephemeral: true });
                    break;
                
                case 'registration_edit':
                    // Capture the original eventId and eventName
                    const { eventId: originalEventId, event: originalEventName } = ongoingRegistration.dataValues;
                    const existingUserDetails = await UserModel.findOne({ where: { discorduser: userId } });

                    if (existingUserDetails) {
                        // Update the ongoingRegistration directly
                        ongoingRegistration.discorduser = userId;
                        ongoingRegistration.nickname = existingUserDetails.nickname;
                        ongoingRegistration.firstname = existingUserDetails.firstname;
                        ongoingRegistration.lastname = existingUserDetails.lastname;
                        ongoingRegistration.email = existingUserDetails.email;
                        ongoingRegistration.country = existingUserDetails.country;
                        ongoingRegistration.eventId = originalEventId;
                        ongoingRegistration.event = originalEventName;
                
                        // Save the updated registration
                        await ongoingRegistration.save();
                    }

                    ongoingRegistration.stage = 'collectingNickname';
                    await ongoingRegistration.save();

                    const regPrefSeatsEmbed = new EmbedBuilder()
                        .setTitle('Let\'s edit your registration')
                        .setDescription('Please provide your nickname.')
                        .setColor('#2dcc20');
                    await interaction.reply({ embeds: [regPrefSeatsEmbed] });

                    break;

                case 'registration_continue':
                    try {
                        // Insert/Update user details in UserModel
                        let user = await UserModel.findOne({ where: { discorduser: userId } });
                        if (user) {
                            user.nickname = ongoingRegistration.nickname;
                            user.firstname = ongoingRegistration.firstname;
                            user.lastname = ongoingRegistration.lastname;
                            user.email = ongoingRegistration.email;
                            user.country = ongoingRegistration.country;
                            await user.save();
                        } else {
                            user = await UserModel.create({
                                discorduser: userId,
                                nickname: ongoingRegistration.nickname,
                                firstname: ongoingRegistration.firstname,
                                lastname: ongoingRegistration.lastname,
                                email: ongoingRegistration.email,
                                country: ongoingRegistration.country
                            });
                        }

                        const eventExists = await EventModel.findByPk(ongoingRegistration.eventId);
                        if (user && eventExists) {
                            try {
                                const existingEventUser = await EventUsersModel.findOne({
                                    where: {
                                        userId: user.id,
                                        eventId: ongoingRegistration.eventId
                                    }
                                });
                                
                                if (existingEventUser) {
                                    await existingEventUser.update({
                                        seat: ongoingRegistration.seat,
                                        status: 'confirmed'
                                    });
                                } else {
                                    await EventUsersModel.create({
                                        userId: user.id,
                                        eventId: ongoingRegistration.eventId,
                                        seat: ongoingRegistration.seat,
                                        status: 'confirmed'
                                    });
                                }                                 
                            } catch (error) {
                                console.error("Error inserting into EventUsersModel:", error);
                            }
                        } else {
                            console.error(`User or Event does not exist. User: ${Boolean(user)}, Event: ${Boolean(eventExists)}`);
                        }

                        // Cleanup the ongoing registration data
                        await TemporaryRegistration.destroy({ where: { discorduser: userId } });
                        await interaction.deferReply({ ephemeral: true });

                        const eventDetails = await EventModel.findByPk(ongoingRegistration.eventId);
                        if (!eventDetails) {
                            throw new Error('Event not found for the given ID');
                        }
                        const eventName = eventDetails.name;

                        // Sending the final registration and payment embeds
                        const [registrationEmbed, paymentDetailsEmbed] = createConfirmationEmbeds({
                            discorduser: interaction.user.tag, 
                            nickname: ongoingRegistration.nickname, 
                            firstname: ongoingRegistration.firstname,
                            lastname: ongoingRegistration.lastname,
                            email: ongoingRegistration.email,
                            country: ongoingRegistration.country,
                            seat: ongoingRegistration.seat,
                            event: eventName
                        });
                        await interaction.user.send({ embeds: [registrationEmbed, paymentDetailsEmbed] });

                        // Update the seating map and participant list
                        await updateParticipantList(interaction.client, ongoingRegistration.eventId);

                    } catch (error) {
                        console.error('Error finalizing registration:', error.message);
                        await interaction.reply('There was an error finalizing your registration. Please try again later.');
                    }
                    break;
                
                case 'country_yes':
                    // Handle the 'yes' confirmation for country code                   
                    if (ongoingRegistration && ongoingRegistration.unconfirmedCountry) {
                        await interaction.deferReply({ ephemeral: true });
                        ongoingRegistration.country = ongoingRegistration.unconfirmedCountry;
                        ongoingRegistration.unconfirmedCountry = null; // Clear the temporary field
                        ongoingRegistration.stage = 'collectingPreferredSeats';

                        try {
                            await ongoingRegistration.save();
                        } catch (error) {
                            console.error("Error saving Temporary Registration:", error.message);
                            await interaction.reply({ content: "An error occurred. Please try again later.", ephemeral: true });
                            return;
                        }
                        
                        // Generate the seating map and send to the user before asking for preferred seats.
                        const tempReg = await TemporaryRegistration.findOne({ where: { discorduser: interaction.user.id } });

                        try {
                            const seatingMapBuffer = await generateCurrentSeatingMap(tempReg.eventId); 
                            await interaction.user.send({
                                files: [{
                                    attachment: seatingMapBuffer,
                                    name: 'seating-map.png'
                                }],
                                content: "Here's the current seating map. Please review it before providing your preferred seats:"
                            });
                        } catch (error) {
                            console.error("Error generating seating map:", error);
                            await interaction.user.send("An error occurred while generating the seating map. Continuing with registration...");
                        }

                        const regPrefSeatsEmbed = new EmbedBuilder()
                                .setTitle('Preferred Seats')
                                .setDescription('Please provide your preferred seats for the event.\nFormated as a comma-separated list e.g. 3,11,29,...')
                                .setColor('#2dcc20');
                            await interaction.user.send({ embeds: [regPrefSeatsEmbed] });
                    } else {
                        await interaction.reply({ content: "Couldn't find your ongoing registration.", ephemeral: true });
                    }
                    break;
                
                case 'country_no':
                    // Handle the 'no' confirmation for country code
                    if (ongoingRegistration) {
                        await interaction.deferReply({ ephemeral: true });

                        ongoingRegistration.unconfirmedCountry = null; // Clear the temporary field
                        ongoingRegistration.stage = 'collectingCountry';
                        try {
                            await ongoingRegistration.save();
                        } catch (error) {
                            console.error("Error saving Temporary Registration:", error.message);
                            await interaction.reply({ content: "An error occurred. Please try again later.", ephemeral: true });
                            return;
                        }
                        const regCountryEmbed = new EmbedBuilder()
                            .setTitle('Country')
                            .setDescription('Please provide your country of residence.\n\nUse a two letter country code [alpha-2-code] \nhttps://www.iban.com/country-codes')
                            .setColor('#2dcc20');
                        await interaction.user.send({ embeds: [regCountryEmbed] });
                        
                    } else {
                        await interaction.reply({ content: "Couldn't find your ongoing registration.", ephemeral: true });
                    }
                    break;
                    
            }
        }
	},
};

async function handleEventAutocomplete(interaction) {
    try {
        const searchTerm = (interaction.options.getFocused()?.value || "").toLowerCase();
        const events = await listEvents({ all: true });  // Pass true to fetch all events including archived

        // Both /adminadd and /admindel will provide event ID as a string
        const matchingEvents = events
            .filter(event => event.name.toLowerCase().includes(searchTerm))
            .slice(0, 25)
            .map(event => ({ name: event.name, value: event.id.toString() }));

        await interaction.respond(matchingEvents);
    } catch (error) {
        logger.error(`Error handling autocomplete for "event": ${error.message}`);
        await interaction.respond([]);
    }
}


async function handleUserAutocomplete(interaction) {
    try {
        const searchTerm = interaction.options.getString('nickname')?.toLowerCase() || "";
        const users = await listUsers();

        const matchingUsers = users
            .filter(user => user.nickname.toLowerCase().includes(searchTerm))
            .slice(0, 25)
            .map(user => ({ name: user.nickname, value: user.nickname }));

        await interaction.respond(matchingUsers);
    } catch (error) {
        logger.error(`Error handling autocomplete for "nickname": ${error.message}`);
        await interaction.respond([]);
    }
}

async function handleUserEventAutocomplete(interaction) {
    try {
        // Extract the value for the 'nickname' option to identify the user
        const nicknameOption = interaction.options._hoistedOptions.find(option => option.name === 'nickname');
        const userNickname = nicknameOption?.value || "";

        // Get the user's discord ID using the nickname
        const user = await UserModel.findOne({ where: { nickname: userNickname } });
        if (!user) {
            logger.error('User not found:', userNickname);
            return await interaction.respond([]);
        }

        // Now fetch the events for the user using the Discord ID
        const eventsForUser = await listEventsForUser(user.discorduser);

        if (!eventsForUser || eventsForUser.length === 0) {
            logger.error('No events found for the user.');
            return await interaction.respond([]);
        }

        // No need for further filtering as the list should contain only the events the user is a part of
        const eventSuggestions = eventsForUser
            .slice(0, 25)
            .map(event => ({ name: event.name, value: event.id.toString() }));  // Assuming events have an 'id' property

        await interaction.respond(eventSuggestions);
    } catch (error) {
        logger.error(`Error handling autocomplete for "event" under "user": ${error.message}`);
        await interaction.respond([]);
    }
}

async function handleEventUserNicknameAutocomplete(interaction) {
    try {
        const eventId = interaction.options.getString('event');

        // Fetch the event using the provided ID
        const eventRecord = await EventModel.findByPk(eventId, {
            include: [{ model: UserModel, as: 'users' }]
        });

        if (!eventRecord) {
            logger.error('Error: Event not found with ID:', eventId);
            return await interaction.respond([]);
        }

        const userSuggestions = eventRecord.users
            .slice(0, 25)
            .map(user => ({ name: user.nickname, value: user.nickname }));

        await interaction.respond(userSuggestions);
    } catch (error) {
        logger.error(`Error handling autocomplete for "nickname" under "eventuser": ${error.message}`);
        await interaction.respond([]);
    }
}

async function handleCountryAutocomplete(interaction) {
    try {
        const searchTerm = (interaction.options.getFocused()?.value || "").toLowerCase();

        const matchingCountries = countries
            .filter(country => country.name.toLowerCase().includes(searchTerm))
            .slice(0, 25);

        await interaction.respond(matchingCountries);
    } catch (error) {
        logger.error(`Error handling autocomplete for "country": ${error.message}`);
        await interaction.respond([]);
    }
}

function createConfirmationEmbeds(data) {
	const fields = [
		{ name: "Discord Username", value: data.discorduser || "Unknown" },
		{ name: 'Nickname', value: data.nickname },
		{ name: 'Firstname', value: data.firstname },
		{ name: 'Lastname', value: data.lastname },
		{ name: "Country", value: data.country },
		{ name: "E-mail address", value: data.email },
		{ name: "Assigned seat", value: data.seat }
	];

    // First embed
    const registrationEmbed = new EmbedBuilder()
    .setTitle(`Congratulations ${data.discorduser}!  :partying_face: :tada: \n\nYou have registered to attend **__${data.event}__**`)
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

    // Second embed
    const paymentDetailsEmbed = new EmbedBuilder()
        .setTitle("Payment details")
        .setDescription(":moneybag: You will **not** be added to the events participant list until you have paid the entry fee.\n\n:chair: Your seat will be reserved for __14 days__ and will then be made available for other participants to claim!\n\n:money_with_wings: You can receive a refund (in case of dropout) up until 60 days before the event start date.")
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
