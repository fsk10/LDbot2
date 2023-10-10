const { Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder } = require('discord.js');
const { Sequelize } = require('sequelize');
const { listEvents, listUsers, listEventsForUser, generateCurrentSeatingMap, updateParticipantList, getAvailableSeatsForEvent, scheduleParticipantListUpdate } = require('../database/operations');
const { UserModel, EventModel, EventUsersModel, TemporaryRegistration } = require('../models');
const logger = require('../utils/logger');
const countries = require('../config/countryList');
const logActivity = require('../utils/logActivity');

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
                logger.error(`Error executing ${interaction.commandName}: ${error.message}`);
                if (error instanceof Sequelize.ValidationError) {
                    for (const validationErrorItem of error.errors) {
                        logger.error(`Validation error on field ${validationErrorItem.path}: ${validationErrorItem.message}`);
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
                case 'adminannounce':
                    if (focusedOptionName === 'event') {
                        await handleEventAutocomplete(interaction);
                    }
                    break;
                case 'unregister':
                    if (focusedOptionName === 'event') {
                        await handleUnregisterAutocomplete(interaction);
                    }
                    break;                   
            }
        }
		
		if (interaction.isButton()) {
			let userId = interaction.user.id;

            // Check if the user exists in the ongoingRegistrations object
            let ongoingRegistration = await TemporaryRegistration.findOne({ where: { discorduser: userId } });

            const [action, eventToUnregisterFrom] = interaction.customId.split('-');
            
            switch (interaction.customId) {
                case 'registration_confirm':
                    // Check if the ongoing registration exists
                    if (!ongoingRegistration) {
                        const regNoOngoingEmbed = new EmbedBuilder()
                            .setTitle('No Registration In-Progress')
                            .setDescription('No ongoing registration found. Please start the registration process again.')
                            .setColor('#0089E4');
                        await interaction.reply({ embeds: [regNoOngoingEmbed] });
                        return;
                    }
                    // Clean up the ongoing registration data and send a feedback message
                    await TemporaryRegistration.destroy({ where: { discorduser: userId } });
                    ongoingRegistration = null;
                    break;
            }

            switch (action) {
                case 'confirm_unregistration':
                    try {
                        const user = await UserModel.findOne({ where: { discorduser: userId } });
                        const event = await EventModel.findOne({ where: { name: eventToUnregisterFrom } });
                        const userRegistration = await EventUsersModel.findOne({
                            where: { userId: user.id, eventId: event.id }
                        });

                        if (!userRegistration) {
                            return interaction.update({ content: `You are not registered for the event "${eventToUnregisterFrom}".`, ephemeral: true, components: [] });
                        }

                        // Unregister the user
                        await userRegistration.destroy();

                        // Update the participant list
                        await scheduleParticipantListUpdate(interaction.client, event.id);

                        // Create a new Embed
                        const updatedEmbed = new EmbedBuilder()
                            .setTitle("Registration Removed")
                            .setDescription(`You have successfully removed yourself from the event!`)
                            .setColor("#FFA500");  // You can adjust the color or other properties as needed

                        // Send the updated embed
                        interaction.update({ embeds: [updatedEmbed], components: [] });

                        // Log the successful registration
                        logActivity(interaction.client, `User **${user.nickname}** (${interaction.user.tag}) has unregistered from the event **${eventToUnregisterFrom}**.`);

                    } catch (error) {
                        logger.error(`Error executing /unregister: ${error.message}`);
                        interaction.update({ content: 'An error occurred while processing your request.', ephemeral: true, components: [] });
                    }
                    return;
                
                case 'cancel_unregistration':
                    // Check if there is an embed
                    if (!interaction.message.embeds.length) {
                        logger.error("No embeds found in the message.");
                        return;
                    }
                
                    // Re-create the embed
                    const originalEmbed = interaction.message.embeds[0];
                    const newEmbed = new EmbedBuilder()
                        .setTitle("Registration Still Active")
                        .setDescription(`You have aborted your action to unregister from the event.`)
                        .setColor(originalEmbed.color)
                        // Copy over any other properties you want to retain from the originalEmbed
                
                    interaction.update({ embeds: [newEmbed], components: [] });
                    return;
                    
            }


            if (!ongoingRegistration) {
                if (interaction.customId === 'registration_confirm') {
                    const regNoChangeEmbed = new EmbedBuilder()
                        .setTitle('No Changes')
                        .setDescription('No changes were made to your registration.')
                        .setColor('#FFA500');
                    await interaction.reply({ embeds: [regNoChangeEmbed] });
                    return;
                }

                const regAlreadyCancelledEmbed = new EmbedBuilder()
                        .setTitle('Already Cancelled')
                        .setDescription('You have already completed or cancelled the registration process.')
                        .setColor('#0089E4');
                    await interaction.reply({ embeds: [regAlreadyCancelledEmbed] });
                    return;
            }

            switch (interaction.customId) {
                case 'registration_cancel':
                    await TemporaryRegistration.destroy({ where: { discorduser: interaction.user.id } });

                    const regCancelledEmbed = new EmbedBuilder()
                        .setTitle('Registration Cancelled')
                        .setDescription('You have cancelled the registration process.')
                        .setColor('#0089E4');
                    await interaction.reply({ embeds: [regCancelledEmbed] });
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

                        const eventUserDetails = await EventUsersModel.findOne({ where: { userId: existingUserDetails.id, eventId: originalEventId } });

                        if (eventUserDetails) {
                            ongoingRegistration.reserve = eventUserDetails.reserve;
                        }
                
                        // Save the updated registration
                        await ongoingRegistration.save();

                    } else {
                        const regErrorOccurredEmbed = new EmbedBuilder()
                            .setTitle('Error Occured')
                            .setDescription('An error occurred while fetching your details. Please try again later.')
                            .setColor('#DD3601');
                        await interaction.reply({ embeds: [regErrorOccurredEmbed] });

                        return;
                    }

                    ongoingRegistration.stage = 'collectingNickname';
                    await ongoingRegistration.save();

                    const regPrefSeatsEmbed = new EmbedBuilder()
                        .setTitle('Let\'s edit your registration')
                        .setDescription('Please provide your nickname.')
                        .setColor('#0089E4');
                    await interaction.reply({ embeds: [regPrefSeatsEmbed] });

                    break;

                case 'registration_continue':
                    await interaction.deferReply({ ephemeral: true });
                    
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

                        const eventDetails = await EventModel.findByPk(ongoingRegistration.eventId);
                        if (!eventDetails) {
                            logger.error("No event details found for event ID", ongoingRegistration.eventId);
                            return; 
                        }

                        // Re-fetch the ongoingRegistration object right here
                        ongoingRegistration = await TemporaryRegistration.findOne({ where: { discorduser: userId } });

                        let isReserve = ongoingRegistration.reserve;
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
                                        status: 'confirmed',
                                        reserve: isReserve
                                    });
                                } else {
                                    await EventUsersModel.create({
                                        userId: user.id,
                                        eventId: ongoingRegistration.eventId,
                                        seat: ongoingRegistration.seat,
                                        status: 'confirmed',
                                        reserve: isReserve
                                    });
                                }                                 
                            } catch (error) {
                                logger.error("Error inserting into EventUsersModel:", error);
                            }
                        } else {
                            logger.error(`User or Event does not exist. User: ${Boolean(user)}, Event: ${Boolean(eventExists)}`);
                        }

                        if (!eventDetails) {
                            throw new Error('Event not found for the given ID');
                        }
                        const eventName = eventDetails.name;

                        if (ongoingRegistration.reserve) {
                            // User is on the reserve list. Create a different embed.
                            const reservesRegistrationEmbed = createReserveEmbed({
                                discorduser: interaction.user.tag, 
                                nickname: ongoingRegistration.nickname, 
                                firstname: ongoingRegistration.firstname,
                                lastname: ongoingRegistration.lastname,
                                email: ongoingRegistration.email,
                                country: ongoingRegistration.country,
                                event: eventName
                            });
                            await interaction.user.send({ embeds: reservesRegistrationEmbed });

                            // Log the successful registration as reserve
                            logActivity(interaction.client, `User **${ongoingRegistration.nickname}** (${interaction.user.tag}) has successfully registered for the event **${eventName}** as a __reserve__.`);

                        } else {
                            // User is on the main list. Send the usual confirmation embeds.
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

                            // Log the successful registration as participant
                            logActivity(interaction.client, `User **${ongoingRegistration.nickname}** (${interaction.user.tag}) has successfully registered for the event **${eventName}**.`);
                        }

                        // Update the seating map and participant list
                        // await updateParticipantList(interaction.client, ongoingRegistration.eventId);
                        await scheduleParticipantListUpdate(interaction.client, ongoingRegistration.eventId);

                        // Cleanup the ongoing registration data
                        await TemporaryRegistration.destroy({ where: { discorduser: userId } });

                    } catch (error) {
                        logger.error('Error finalizing registration:', error.message);

                        const regErrorFinalizingEmbed = new EmbedBuilder()
                            .setTitle('Error Finalizing Registration')
                            .setDescription('There was an error finalizing your registration. Please try again later.')
                            .setColor('#DD3601');
                        await interaction.editReply({ embeds: [regErrorFinalizingEmbed] });
                    }
                    break;
                
                case 'country_yes':
                    // Handle the 'yes' confirmation for country code                   
                    if (ongoingRegistration && ongoingRegistration.unconfirmedCountry) {
                        await interaction.deferReply({ ephemeral: true });
                        ongoingRegistration.country = ongoingRegistration.unconfirmedCountry;
                        ongoingRegistration.unconfirmedCountry = null; // Clear the temporary field

                        // Check for available seats before proceeding
                        const seatCheck = await getAvailableSeatsForEvent(ongoingRegistration.eventId, ongoingRegistration.discorduser);

                        let isReserve = false;
                        
                        // Check if the user was already a participant (not a reserve)
                        if (!seatCheck.success || seatCheck.availableSeats <= 0) {
                            isReserve = true;
                        } else if (ongoingRegistration && !ongoingRegistration.reserve) {
                            isReserve = false;
                        } else {
                            isReserve = true;
                        }

                        logger.info(`Value of isReserve after seat check: ${isReserve}`); //debug

                        if (ongoingRegistration.reserve !== isReserve) {
                            ongoingRegistration.reserve = isReserve;
                            await TemporaryRegistration.update({ reserve: isReserve }, { where: { discorduser: userId } });
                        }

                        if (isReserve) {
                            // User is on the reserve list.
                            const user = interaction.client.users.cache.get(ongoingRegistration.discorduser);
                            const username = user ? user.username : ongoingRegistration.discorduser; // use the ID as a fallback

                            
                            // Create the reserve registration confirmation embed
                            const reserveConfirmationEmbed = new EmbedBuilder()
                            .setTitle(`Hello ${username}!`)
                            .setDescription(`**${seatCheck.eventName}** is currently at __MAX CAPACITY__.\n\nTo be added to the **__RESERVES LIST__** press **Continue** below.\nIf a seat becomes available you will be contacted by an admin!`)
                            .setColor('#FFA500')
                            .addFields(
                                { name: 'Nickname', value: ongoingRegistration.nickname },
                                { name: 'Firstname', value: ongoingRegistration.firstname },
                                { name: 'Lastname', value: ongoingRegistration.lastname },
                                { name: 'Email', value: ongoingRegistration.email },
                                { name: 'Country', value: `:flag_${ongoingRegistration.country.toLowerCase()}:` }
                            )
                        
                        // Create buttons (same as before)
                        const row = new ActionRowBuilder()
                            .addComponents(
                                new ButtonBuilder()
                                    .setCustomId('registration_cancel')
                                    .setLabel('Cancel')
                                    .setStyle(4),
                                new ButtonBuilder()
                                    .setCustomId('registration_edit')
                                    .setLabel('Edit responses')
                                    .setStyle(1),
                                new ButtonBuilder()
                                    .setCustomId('registration_continue')
                                    .setLabel('Continue')
                                    .setStyle(3)
                            );

                            ongoingRegistration.stage = 'showingReserveConfirmation';
                            await ongoingRegistration.save();

                            // Send the embed
                            await interaction.user.send({ embeds: [reserveConfirmationEmbed], components: [row] });

                        } else {
                            // Seats are available, continue with the current flow
                            ongoingRegistration.stage = 'collectingPreferredSeats';

                            await ongoingRegistration.save();
                        
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
                                logger.error("Error generating seating map:", error);

                                const regErrorSeatingMapEmbed = new EmbedBuilder()
                                    .setTitle('Error Generating Seating Map')
                                    .setDescription('An error occurred while generating the seating map. Continuing with registration...')
                                    .setColor('#DD3601');
                                await interaction.user.send({ embeds: [regErrorSeatingMapEmbed] });
                            }

                            const regPrefSeatsEmbed = new EmbedBuilder()
                                .setTitle('Preferred Seats')
                                .setDescription('Please provide your preferred seats for the event.\nFormated as a comma-separated list e.g. 3,11,29,...')
                                .setColor('#0089E4');
                            await interaction.user.send({ embeds: [regPrefSeatsEmbed] });
                        }      
                    } else {
                        const regNotOngoingEmbed = new EmbedBuilder()
                            .setTitle('No Ongoing Registration')
                            .setDescription('Could not find your ongoing registration.')
                            .setColor('#DD3601');
                        await interaction.reply({ embeds: [regNotOngoingEmbed] });
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
                            logger.error("Error saving Temporary Registration:", error.message);
                            await interaction.reply({ content: "An error occurred. Please try again later.", ephemeral: true });
                            return;
                        }
                        const regCountryEmbed = new EmbedBuilder()
                            .setTitle('Country')
                            .setDescription('Please provide your country of residence.\n\nUse a two letter country code [alpha-2-code] \nhttps://www.iban.com/country-codes')
                            .setColor('#0089E4');
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
            logger.error(`User not found for nickname: ${userNickname}`);
            return await interaction.respond([]);
        }

        // Now fetch the events for the user using the Discord ID
        const eventsForUser = await listEventsForUser(user.discorduser);

        if (!eventsForUser || eventsForUser.length === 0) {
            logger.error(`No events found for user with nickname: ${userNickname}`);
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

async function handleUnregisterAutocomplete(interaction) {
    try {
        const userId = interaction.user.id;

        // Fetch the user's details
        const user = await UserModel.findOne({ where: { discorduser: userId.toString() } });
        if (!user) {
            return;
        }

        // Fetch the list of events for which the user is registered
        const registeredEvents = await user.getEvents();

        const eventNames = registeredEvents.map(event => {
            return { name: event.name, value: event.name };
        });

        // If there are no events to suggest, respond with a custom message
        if (eventNames.length === 0) {
            await interaction.respond([
                {
                    name: "You are not registered to any events",
                    value: "no_match"
                }
            ]);
            return;
        }

        // Respond with the list of events
        if (Array.isArray(eventNames) && eventNames.length > 0) {
            await interaction.respond(eventNames);
        }
    } catch (error) {
        console.error('Error in handleUnregisterAutocomplete:', error.message, error.stack);
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

function replacer(key, value) {
    if (typeof value === 'bigint') {
      return value.toString() + 'n'; // Convert BigInt to string and append 'n' to indicate it's a BigInt
    } else {
      return value;
    }
  }

function createReserveEmbed(data) {
    const reservesRegistrationEmbed = new EmbedBuilder()
    .setTitle(`You have been added to the **reserves list**`)
    .setDescription(`An admin will contact you if a seat becomes available!`)
    .setColor('#FFA500')
    .addFields(
        { name: "Event", value: data.event, inline: true },
        { name: "Discord User", value: data.discorduser },
        { name: "Nickname", value: data.nickname, inline: true }
    )

    return [reservesRegistrationEmbed];
}

function createConfirmationEmbeds(data) {
    const registrationEmbed = new EmbedBuilder()
    .setTitle(`Congratulations ${data.discorduser}!  :partying_face: :tada: \n\nYou have registered to attend **__${data.event}__**`)
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
