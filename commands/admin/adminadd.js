const { SlashCommandBuilder } = require('@discordjs/builders');
const logger = require('../../utils/logger');
const { addEvent, addUser, getEvent, checkSeatTaken, listEvents, checkUserInEvent, updateParticipantList } = require('../../database/operations');
const options = require('../../config/adminAddConfig');
const countryList = require('../../config/countryList');
const extractOption = require('../../utils/extractOption');
const { isAdmin } = require('../../utils/permissions');
const { getNameFromID } = require('../../utils/getNameFromID');
const logActivity = require('../../utils/logActivity');

function isValidDateTime(dateTimeStr) {
    const regex = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/;
    if (!regex.test(dateTimeStr)) return false;

    const dateObj = new Date(dateTimeStr);
    if (dateObj.toString() === "Invalid Date") return false;

    return true;
}

const data = new SlashCommandBuilder()
    .setName('adminadd')
    .setDescription('Add an event or a user');

// Function to handle adding options
const addOptionToCommand = (opt, command) => {
    switch (opt.type) {
        case 'STRING':
            command.addStringOption(option => 
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required));
            break;
        case 'INTEGER':
            command.addIntegerOption(option => 
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required));
            break;
        case 'USER':
            command.addUserOption(option => 
                option.setName(opt.name)
                    .setDescription(opt.description)
                    .setRequired(opt.required));
            break;
		case 'BOOLEAN':
			command.addBooleanOption(option => 
				option.setName(opt.name)
					.setDescription(opt.description)
					.setRequired(opt.required));
			break;
        // ... Add other type cases as needed
    }
};

// Add options based on external config
for (let subCommandName in options) {
    data.addSubcommand(subcommand => {
        subcommand.setName(subCommandName)
            .setDescription(`Add a new ${subCommandName}`);
        
        options[subCommandName].forEach(option => {
            addOptionToCommand(option, subcommand);
        });

        return subcommand;
    });
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

	if (subcommand === 'event') {
		try {
			let eventData = {};

			// Extracting the start and end dates from the interaction
			const startDateStr = interaction.options.getString('startdate');
			const endDateStr = interaction.options.getString('enddate');

			// Check if the provided dates are in a valid format
			if (!isValidDateTime(startDateStr) || !isValidDateTime(endDateStr)) {
				return await interaction.reply({
					content: 'Invalid date-time format. Please use the format YYYY-MM-DD HH:mm.',
					ephemeral: true
				});
			}

			// Convert string dates to JavaScript Date objects
			const startDateObj = new Date(startDateStr);
			const endDateObj = new Date(endDateStr);

			// Ensure that the start date is before the end date
			if (startDateObj > endDateObj) {
				return await interaction.reply({
					content: 'Start date cannot be after end date. Please correct the dates.',
					ephemeral: true
				});
			}

			// Fetch the channel ID provided for participantchannel
			const channelMention = interaction.options.getString('participantchannel');
			if (channelMention) {
				const channelIdMatch = channelMention.match(/<#(\d+)>/);
				if (!channelIdMatch) {
					return await interaction.reply({
						content: `Invalid channel mention. Please provide a valid channel mention.`,
						ephemeral: true
					});
				}

				const channelId = channelIdMatch[1];
				const channel = client.channels.cache.get(channelId);
				if (!channel) {
					logger.error(`Channel with ID ${channelId} not found in the cache.`);
					return await interaction.reply({
						content: `Invalid channel ID. Please provide a valid channel ID.`,
						ephemeral: true
					});
				}

				if (channel.type !== 0) {
					return await interaction.reply({
						content: `Invalid channel type. Expected GUILD_TEXT but found ${channel.type}.`,
						ephemeral: true
					});
				}

				eventData['participantchannel'] = channelId;
			} else {
				eventData['participantchannel'] = null;
			}
	
			// Extract all event data from the interaction options
			for (let optionConfig of options[subcommand]) {
				const optionName = optionConfig.name;
				eventData[optionName] = extractOption(optionName, interaction, optionConfig.extractionMethod);
			}

			// Attempt to add the event to the database
			const result = await addEvent(eventData);


			if (result.success) {
				logActivity(client, `Event **${eventData.name}** was added by ${interaction.user.tag}`);
				await interaction.reply({
					content: `Event **${eventData.name}** added successfully!`,
					ephemeral: true
				});
			} else {
				await interaction.reply({
					content: 'Error adding event. Please try again.',
					ephemeral: true
				});
			}
		} catch (error) {
			logger.error('Error executing adminadd event command:', error);
			await interaction.reply({
				content: 'An error occurred while adding the event. Please try again.',
				ephemeral: true
			});
		}

	} else if (subcommand === 'user') {
		try {
			const userData = {};
			for (let optionConfig of options[subcommand]) {
				const optionName = optionConfig.name;
				userData[optionName] = extractOption(optionName, interaction, optionConfig.extractionMethod);
			}

			// Fetch the event
			const eventId = interaction.options.getInteger('event');
			const event = await getEvent(eventId);
			if (!event) {
				return await interaction.reply({
					content: 'The specified event does not exist.',
					ephemeral: true
				});
			}

			// Check if user already exists in the event
			const userExists = await checkUserInEvent(userData.discorduser, eventId);
			if (userExists) {
				return await interaction.reply({
					content: `User with ID ${userData.discorduser} is already registered for event ${event.name}.`,
					ephemeral: true
				});
			}
	
			// Check if seat exceeds event's seats
			if (userData.seat > event.seatsAvailable) {
				return await interaction.reply({
					content: `The seat number exceeds the available seats for this event. Maximum seat number is ${event.seatsAvailable}.`,
					ephemeral: true
				});
			}
	
			// Check if the seat is already taken
			const isSeatTaken = await checkSeatTaken(eventId, userData.seat);
			if (isSeatTaken) {
				return await interaction.reply({
					content: 'The specified seat is already taken for this event. Please choose a different seat.',
					ephemeral: true
				});
			}
			
			// Get the discord username from the discord userID
			const nameResult = await getNameFromID(interaction, userData.discorduser);
			let displayName = userData.discorduser;  // Default to ID if not found
			if (nameResult && nameResult.type === 'user') {
				displayName = nameResult.name;
			}

			// Add the user
			const result = await addUser(userData, client);
			if (result.success) {
				logActivity(client, `User **${displayName}** (${userData.nickname}) was added to event **${event.name}** by ${interaction.user.tag}`);
				await interaction.reply({
					content: `User **${displayName}** (${userData.nickname}) was added successfully to event **${event.name}**!`,
					ephemeral: true
				});
				await updateParticipantList(client, eventId);
			} else {
				// Use the error message returned by the addUser function
				await interaction.reply({
					content: result.error || 'Error adding user. Please try again.',
					ephemeral: true
				});
			}

		} catch (error) {
			logger.error("Caught Error Message:", error.message);
			if (error.message === "A user with this email already exists.") {
				await interaction.reply({
					content: error.message,
					ephemeral: true
				});
			} else {
				await interaction.reply({
					content: "An error occurred while adding the user. Please try again.",
					ephemeral: true
				});
			}
		}
	}
}

async function prepare() {
    const events = await listEvents();
    const eventChoices = events.map(event => ({
        name: event.name,
        value: event.id.toString()
    }));

    const userSubcommand = data.options.find(option => option.name === 'user');
    
    // Update event choices
    const eventOption = userSubcommand.options.find(option => option.name === 'event');
	eventOption.autocomplete = true;
    // eventOption.choices = eventChoices;

    // Update country choices
    const countryOption = userSubcommand.options.find(option => option.name === 'country');
    countryOption.choices = countryList;

    return data;
}


module.exports = {
    data,
    execute,
    prepare
};
