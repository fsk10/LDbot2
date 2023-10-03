const { REST, Routes } = require('discord.js');
const { CLIENT_ID, SERVER_ID, BOT_TOKEN } = require('./config.json');
const fs = require('node:fs');
const path = require('node:path');
const commands = [];
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);
const prepareCommands = [];
const logger = require('./utils/logger');

for (const folder of commandFolders) {
    const commandsPath = path.join(foldersPath, folder);
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        if ('data' in command && 'execute' in command) {
            if (typeof command.prepare === 'function') {
                prepareCommands.push(command.prepare);
            } else {
                commands.push(command.data);
            }
        } else {
            console.warn(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
}

const rest = new REST().setToken(BOT_TOKEN);

module.exports = async function deployCommands() {
    for (const prepareFunc of prepareCommands) {
        const commandData = await prepareFunc();
        if (commandData) {  // Only push to commands if commandData is truthy (i.e., not null or undefined).
            commands.push(commandData);
        }
    }

    try {
        logger.info(`Started refreshing ${commands.length} application (/) commands.`);
        const data = await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, SERVER_ID),
            { body: commands },
        );
        logger.info(`Successfully reloaded ${data.length} application (/) commands.`);
    } catch (error) {
        console.error(error);
    }
};
