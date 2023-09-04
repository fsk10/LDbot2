const { Events } = require('discord.js');
const logger = require('../utils/logger');

module.exports = {
	name: Events.InteractionCreate,
	async execute(interaction) {
		if (!interaction.isChatInputCommand()) return;

		const command = interaction.client.commands.get(interaction.commandName);

		if (!command) {
			logger.error(`No command matching ${interaction.commandName} was found.`);
			return;
		}

		try {
			await command.execute(interaction, interaction.client);  // Pass the client here
		} catch (error) {
			logger.error(`Error executing ${interaction.commandName}`);
			logger.error(error);
		}		
	},
};