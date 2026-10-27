/**
 @document   : app.js
 @author     : Peter Hedman
 @version    : 1.0.0
 @copyright  : 2023, Peter Hedman
 @license    : GNU General Public License v3.0
 @description: LANet Deluxe event-bot
*/

global.ongoingRegistrations = {};

const fs = require('node:fs');
const path = require('node:path');
const logger = require('./utils/logger');
const { Client, Collection, Events, GatewayIntentBits, Partials } = require('discord.js');
const { BOT_TOKEN } = require('./config.json');
require('./models');
const { initializeDatabase } = require('./database/database');
const deployCommands = require('./deploy-commands');
const cron = require('node-cron');
const { autoCloseEndedEventRegistrations, tickReserveOffers } = require('./database/operations');
const { tickAnnounceJobs } = require('./scheduler/announcementsCron');
const { tickPaymentReminders } = require('./scheduler/paymentReminders');
const crashGuard = require('./utils/crashGuard');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
	GatewayIntentBits.DirectMessages,
  ],
  // Without this, DMs in a channel not cached since startup (e.g. someone
  // typing their seats right after a restart) are silently dropped
  partials: [Partials.Channel],
})

crashGuard.install(client);

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

// Run every 10 minutes
cron.schedule('*/10 * * * *', autoCloseEndedEventRegistrations);
cron.schedule('*/10 * * * *', () => tickPaymentReminders(client));
// Resumes reserve seat offers interrupted by a restart
cron.schedule('*/10 * * * *', () => tickReserveOffers(client));

// Run the announcement scheduler every minute
cron.schedule('* * * * *', () => {
  try { tickAnnounceJobs(client); } catch (e) { logger.error('tickAnnounceJobs error:', e); }
});

(async () => {
  await initializeDatabase();
  await deployCommands();
  await client.login(BOT_TOKEN);
})().catch(err => {
  // Startup failures must still exit so PM2 restarts us (rethrow as uncaught → crashGuard).
  setImmediate(() => { throw err; });
});
