const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { scheduleCountdownUpdate } = require('../utils/countdown');

module.exports = {
	name: Events.ClientReady,
	once: true,
	async execute(client) {
		logger.info(`Ready! Logged in as ${client.user.tag}`);
		try {
			await scheduleCountdownUpdate(client); // Ensure the countdown update schedule starts
		} catch (error) {
			logger.error(`Error scheduling countdown update: ${error.message}`);
		}
	},
};