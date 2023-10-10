const { SlashCommandBuilder } = require('@discordjs/builders');
const { listUsers, listEvents } = require('../../database/operations');
const { EmbedBuilder } = require('discord.js');
const { isAdmin } = require('../../utils/permissions');
const  formatDisplayDate  = require('../../utils/dateUtils');
const { EventModel } = require('../../models');
const { getNameFromID } = require('../../utils/getNameFromID');

const commandData = new SlashCommandBuilder()
    .setName('adminlist')
    .setDescription('List events or users')
    .addSubcommand(subcommand => 
        subcommand.setName('users')
            .setDescription('List all users')
            .addStringOption(option => 
                option.setName('event')
                    .setDescription('Select an event')
                    .setRequired(false)
            )
            .addStringOption(option => 
                option.setName('output')
                    .setDescription('Output format: full or short')
                    .setRequired(false)
                    .addChoices({ name: 'Short', value: 'short' }, { name: 'Full', value: 'full' }),
            )
    )
    .addSubcommand(subcommand => 
        subcommand.setName('events')
            .setDescription('List all events')
            .addBooleanOption(option =>
                option.setName('all')
                    .setDescription('Show all events including archived')
                    .setRequired(false)
            )
            .addBooleanOption(option =>
                option.setName('archived')
                    .setDescription('Show only archived events')
                    .setRequired(false)
            )
    )
   


async function splitEmbeds(users, eventName, interaction, outputType = 'short', allUsers = false) {
    const MAX_SIZE = 4096;

    let embeds = [];
    let currentEmbedDescription = "​";
    let charCount = currentEmbedDescription.length;

    for (const user of users) {
        const seat = user.events && user.events[0] ? user.events[0].EventUsers.seat : 'N/A';
        const haspaid = user.events && user.events[0] ? user.events[0].EventUsers.haspaid : false;
        const reserve = user.events && user.events[0] ? user.events[0].EventUsers.reserve : false;
        const seatInfo = (seat && seat !== 'N/A') ? `Seat: ${seat}\n` : '';

        const nameResult = await getNameFromID(interaction, user.discorduser);
        const discordName = (nameResult && nameResult.type === 'user') ? `${nameResult.name}` : 'Unknown';

        let userInfo;
        let notPaidIndicator = (!haspaid && !reserve) ? ' :small_orange_diamond:' : ''; // Add the not paid icon if the user hasn't paid and isn't a reserve

        if (allUsers) {
            if (outputType === 'short') {
                userInfo = `:flag_${user.country.toLowerCase()}: **${user.nickname}** (${discordName})${reserve ? ' :small_red_triangle:' : ''}${notPaidIndicator}\n`;
            } else {
                const eventList = user.events.map(e => `:white_small_square: ${e.name}`).join('\n');
                userInfo = `**${user.nickname}**\nUser ID: ${user.id}\nDiscord Name: ${discordName}\nDiscord ID: ${user.discorduser}\nFull Name: ${user.firstname} ${user.lastname}\nEmail: ${user.email}\nCountry: :flag_${user.country.toLowerCase()}:\nIn Event(s):\n${eventList}\n\n`;
            }
        } else {
            if (outputType === 'short') {
                const seatText = (!reserve && seat !== 'N/A') ? `[#${seat}]` : '';
                userInfo = `:flag_${user.country.toLowerCase()}: **${user.nickname}** (${discordName}) ${seatText} ${reserve ? ' :small_red_triangle:' : ''}${notPaidIndicator}\n`;
            } else {
                userInfo = `**${user.nickname}**\nUser ID: ${user.id}\nDiscord Name: ${discordName}\nDiscord ID: ${user.discorduser}\nReserve: ${reserve ? 'Yes' : 'No'}\n${seatInfo}Paid: ${haspaid ? 'Yes' : 'No'}\nFull Name: ${user.firstname} ${user.lastname}\nEmail: ${user.email}\nCountry: :flag_${user.country.toLowerCase()}:\n\n`;
            }
        }

        if (charCount + userInfo.length > MAX_SIZE) {
            embeds.push(new EmbedBuilder()
                .setTitle("User List")
                .setDescription(currentEmbedDescription)
                .setColor('#0089E4'));

            currentEmbedDescription = "​";
            charCount = currentEmbedDescription.length;
        }

        currentEmbedDescription += userInfo;
        charCount += userInfo.length;
    };

    if (charCount > 0) {
        embeds.push(new EmbedBuilder()
            .setTitle(`User List (${eventName})`)
            .setDescription(`:small_red_triangle: Reserve :small_orange_diamond: Unpaid entry fee\n\n${currentEmbedDescription}`)
            .setColor('#0089E4'));
    }

    return embeds;
}


async function execute(interaction) {
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

    if (subcommand === 'users') {
        let eventId = interaction.options.getString('event');
        let outputType = interaction.options.getString('output') || 'short';  // Default to 'short' if not provided
    
        // Fetch and list users
        const users = await listUsers(eventId);
    
        let eventName = "All Users";
        let allUsers = false;
        if (eventId) {
            const event = await EventModel.findOne({ where: { id: eventId } });
            eventName = event ? event.name : "Unknown Event";
        } else {
            allUsers = true;
        }
    
        const userEmbeds = await splitEmbeds(users, eventName, interaction, outputType, allUsers);
    
        // Defer the reply to the interaction.
        await interaction.deferReply({ ephemeral: true });
    
        // Now, for each embed in userEmbeds, send it as a follow-up.
        for (const embed of userEmbeds) {
            await interaction.followUp({ embeds: [embed], ephemeral: true });
        }

    } else if (subcommand === 'events') {
        const archived = interaction.options.getBoolean('archived');
        const events = await listEvents({ all: interaction.options.getBoolean('all'), archived: interaction.options.getBoolean('archived') });

        const embed = new EmbedBuilder()
            .setTitle('List of Events')
            .setColor('#0089E4');

            events.forEach(event => {
                const formattedStartDate = formatDisplayDate(event.startdate);
                const formattedEndDate = formatDisplayDate(event.enddate);
                embed.addFields(
                    { 
                        name: event.name, 
                        value: `Event ID: ${event.id}\nLocation: ${event.location}\nStart Date: ${formattedStartDate}\nEnd Date: ${formattedEndDate}\nSeats: ${event.seatsavailable}\nEntry Fee: €${event.entryfee}\nParticipant Channel: ${event.participantchannel}` 
                    }
                );
            });

        await interaction.reply({ 
            embeds: [embed], 
            ephemeral: true 
        });
    }
}

async function prepare() {
    const events = await listEvents();
    const eventChoices = events.map(event => ({
        name: event.name,
        value: event.id.toString()
    }));

    const usersSubcommand = commandData.options.find(option => option.name === 'users');
    
    // Update event choices
    const eventOption = usersSubcommand.options.find(option => option.name === 'event');
    eventOption.choices = eventChoices;

    return commandData;
}



module.exports = {
    data: commandData,
    execute,
    prepare
};
