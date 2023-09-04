const { SlashCommandBuilder } = require('@discordjs/builders');
const { isAdmin } = require('../../utils/permissions');
const { deleteEvent, deleteUserFromEvent, listEvents, listUsers } = require('../../database/operations');
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
            ))
    .addSubcommand(subcommand => 
        subcommand.setName('user')
            .setDescription('Delete a user from an event')
            .addStringOption(option => 
                option.setName('username')
                    .setDescription('Name of the user to delete')
                    .setRequired(true)
            )
            .addStringOption(option => 
                option.setName('eventname')
                    .setDescription('Name of the event')
                    .setRequired(true)
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
        const eventName = interaction.options.getString('eventname');
        const result = await deleteEvent(eventName);

        if (result.success) {
            logActivity(client, `Event **${eventName}** has been deleted by ${interaction.user.tag}`);
            await interaction.reply({
				content: `Event **${eventName}** has been deleted.`,
				ephemeral: true
		});
        } else {
            await interaction.reply({
                content: result.error,
                ephemeral: true
            });
        }
    } else if (subcommand === 'user') {
        const username = interaction.options.getString('username');
        const eventName = interaction.options.getString('eventname');
        const result = await deleteUserFromEvent(username, eventName);

        if (result.success) {
            logActivity(client, `User **${username}** has been removed from the event **${eventName}** by ${interaction.user.tag}`);
            await interaction.reply({
				content: `User **${username}** has been removed from the event **${eventName}**.`,
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

async function prepare() {
    const events = await listEvents();
    const users = await listUsers();
    
    const eventSubcommand = commandData.options.find(option => option.name === 'event');
    const userSubcommand = commandData.options.find(option => option.name === 'user');
    
    // Populate dynamic choices for events and users in the event subcommand
    const eventNameOptionForEvent = eventSubcommand.options.find(option => option.name === 'eventname');
    eventNameOptionForEvent.choices = events.map(event => ({
        name: event.name,
        value: event.name
    }));
    
    // Populate dynamic choices for username in the user subcommand
    const usernameOption = userSubcommand.options.find(option => option.name === 'username');
    usernameOption.choices = users.map(user => ({
        name: user.nickname,
        value: user.nickname
    }));

    // Populate dynamic choices for eventname in the user subcommand
    const eventNameOptionForUser = userSubcommand.options.find(option => option.name === 'eventname');
    eventNameOptionForUser.choices = events.map(event => ({
        name: event.name,
        value: event.name
    }));

    return commandData;
}

module.exports = {
    data: commandData,
    execute,
    prepare
};
