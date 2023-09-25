/**
 @document   : app.js
 @author     : Peter Hedman
 @version    : 1.0.0
 @copyright  : 2023, Peter Hedman
 @license    : GNU General Public License v3.0
 @description: LANet Deluxe event-bot
*/

for (const module in require.cache) {
    if (require.cache[module].id.endsWith('.js')) {
        delete require.cache[module];
    }
}

global.ongoingRegistrations = {};

const fs = require('node:fs');
const path = require('node:path');
const logger = require('./utils/logger');
const { Client, Collection, Events, GatewayIntentBits } = require('discord.js');
const { BOT_TOKEN } = require('./config.json');
const { initializeDatabase } = require('./database/database');
const deployCommands = require('./deploy-commands');
const cron = require('node-cron');
const { releaseUnconfirmedSeats } = require('./database/operations');

// Run every 10 minutes
cron.schedule('*/10 * * * *', releaseUnconfirmedSeats);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
	GatewayIntentBits.DirectMessages,
  ],
})

client.commands = new Collection();
const foldersPath = path.join(__dirname, 'commands');
const commandFolders = fs.readdirSync(foldersPath);

for (const folder of commandFolders) {
	const commandsPath = path.join(foldersPath, folder);
	const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
	for (const file of commandFiles) {
		const filePath = path.join(commandsPath, file);
		const command = require(filePath);
		if ('data' in command && 'execute' in command) {
			client.commands.set(command.data.name, command);
		} else {
			logger.error(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
		}
	}
}

const eventsPath = path.join(__dirname, 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
	const filePath = path.join(eventsPath, file);
	const event = require(filePath);
	if (event.once) {
		client.once(event.name, (...args) => event.execute(...args));
	} else {
		client.on(event.name, (...args) => event.execute(...args));
	}
}

(async () => {
  await initializeDatabase();
  await deployCommands();
  client.login(BOT_TOKEN);

})();
