const { SlashCommandBuilder } = require('@discordjs/builders');
const { isAdmin } = require('../../utils/permissions');
const { deleteEvent, deleteUserFromEvent, listEvents, listUsers, deleteUserCompletely } = require('../../database/operations');
const logActivity = require('../../utils/logActivity');

const commandData = new SlashCommandBuilder()
    .setName('admindel')
    .setDescription('Delete events or user from an event')
    .addSubcommand(subcommand => 
        subcommand.setName('event')
            .setDescription('Delete an event')
            .addStringOption(option => 
                option.setName('eventname')
                    .setDescription('Name of the event to delete')
                    .setRequired(true)
                    .setAutocomplete(true)
            ))
    .addSubcommand(subcommand => 
        subcommand.setName('user')
            .setDescription('Delete a user from an event')
            .addStringOption(option => 
                option.setName('nickname')
                    .setDescription('Name of the user to delete')
                    .setRequired(true)
                    .setAutocomplete(true)
            )
            .addStringOption(option => 
                option.setName('eventname')
                    .setDescription('Name of the event')
                    .setRequired(false)
                    .setAutocomplete(true)
            ));

async function execute(interaction, client) {
    // Check admin permissions
    const userIsAdmin = await isAdmin(interaction);
    
    if (!userIsAdmin) {
        return interaction.reply({
            content: "You don't have the required permissions to use this command.",
            ephemeral: true
        });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'event') {
        const eventId = interaction.options.getString('eventname');
        const result = await deleteEvent(eventId);
    
        if (result.success) {
            logActivity(client, `Event **${result.eventName}** has been deleted by ${interaction.user.tag}`);
            await interaction.reply({
                content: `Event **${result.eventName}** has been deleted.`,
                ephemeral: true
            });
        } else {
            await interaction.reply({
                content: result.error,
                ephemeral: true
            });
        }
    } else if (subcommand === 'user') {
        const nickname = interaction.options.getString('nickname');
        const eventId = interaction.options.getString('eventname');

        // Check if the eventId is provided
        if (eventId) {
            const result = await deleteUserFromEvent(nickname, eventId, client);
            if (result.success) {
                logActivity(client, `User **${nickname}** has been removed from the event **${eventId}** by ${interaction.user.tag}`);
                await interaction.reply({
				    content: `User **${nickname}** has been removed from the event **${eventId}**.`,
				    ephemeral: true
			    });
            } else {
                await interaction.reply({
                    content: result.error,
                    ephemeral: true
                });
            }
        } else {
            // Handle complete user deletion logic here
            const result = await deleteUserCompletely(nickname, client);
            if (result.success) {
                logActivity(client, `User **${nickname}** has been completely deleted by ${interaction.user.tag}`);
                await interaction.reply({
				    content: `User **${nickname}** has been completely deleted.`,
				    ephemeral: true
			    });
            } else {
                await interaction.reply({
                    content: result.error,
                    ephemeral: true
                });
            }
        }
    }
}

async function prepare() {
    const events = await listEvents();
    const users = await listUsers();
    
    const eventSubcommand = commandData.options.find(option => option.name === 'event');
    const userSubcommand = commandData.options.find(option => option.name === 'user');
    
    // // Populate dynamic choices for events and users in the event subcommand
    // const eventIdOptionForEvent = eventSubcommand.options.find(option => option.name === 'eventname');
    // eventIdOptionForEvent.choices = events.map(event => ({
    //     name: event.name,
    //     value: event.name
    // }));
    
    // // Populate dynamic choices for nickname in the user subcommand
    // const nicknameOption = userSubcommand.options.find(option => option.name === 'nickname');
    // nicknameOption.choices = users.map(user => ({
    //     name: user.nickname,
    //     value: user.nickname
    // }));

    // // Populate dynamic choices for eventname in the user subcommand
    // const eventIdOptionForUser = userSubcommand.options.find(option => option.name === 'eventname');
    // eventIdOptionForUser.choices = events.map(event => ({
    //     name: event.name,
    //     value: event.name
    // }));

    return commandData;
}

module.exports = {
    data: commandData,
    execute,
    prepare
};
