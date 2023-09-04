const { REST } = require('discord.js');
const { Routes } = require('discord.js');
const { BOT_TOKEN, CLIENT_ID, SERVER_ID } = require('./config.json');

const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);

async function clearCommands() {
    try {
        // Fetch all commands
        const commands = await rest.get(Routes.applicationGuildCommands(CLIENT_ID, SERVER_ID));

        // Delete each command
        for (const command of commands) {
            console.log(`Deleting command: ${command.name}`);
            await rest.delete(Routes.applicationGuildCommand(CLIENT_ID, SERVER_ID, command.id));
        }

        console.log('All commands deleted successfully.');
    } catch (error) {
        console.error('Error clearing commands:', error);
    }
}

clearCommands();
