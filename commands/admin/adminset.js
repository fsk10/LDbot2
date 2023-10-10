const { SlashCommandBuilder } = require('@discordjs/builders');
const { setSetting } = require('../../database/operations');
const settingsConfig = require('../../config/settingsConfig');
const { processSetting } = require('../../utils/settingsHandler.js');
const { getNameFromID } = require('../../utils/getNameFromID.js');
const { isAdmin } = require('../../utils/permissions');
const logActivity = require('../../utils/logActivity');

const settingChoices = Object.keys(settingsConfig).map(setting => ({ name: setting, value: setting }));

const commandData = new SlashCommandBuilder()
    .setName('adminset')
    .setDescription('Sets a specific admin setting.')
    .addStringOption(option => 
        option.setName('setting')
        .setDescription('Name of the setting to set.')
        .setRequired(true)
        .addChoices(...settingChoices)
    )

    .addStringOption(option => 
        option.setName('value')
        .setDescription('New value for the setting.')
        .setRequired(true)
    );

    async function execute(interaction, client) {

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

        const settingName = interaction.options.getString('setting');
        let value = interaction.options.getString('value');
    
        try {
            const nameResult = await getNameFromID(interaction, value);

            if (nameResult) {
                value = nameResult.name;
            } else {
                // Check if the value matches a potential ID or a Discord mention format
                const isPotentialID = /^\d+$/.test(value) || value.startsWith('<@&') || value.startsWith('<#');

                if (isPotentialID) {
                    interaction.reply({ 
                        content: `The ID provided is neither a valid user, role, nor a channel. Please provide a valid ID.`, 
                        ephemeral: true 
                    });
                } else {
                    interaction.reply({ 
                        content: `The provided value is not a recognized format. Please provide a valid ID or mention.`, 
                        ephemeral: true 
                    });
                }
                return;
            }

    
            const processedValue = processSetting(settingName, value);  // This function processes and validates the input
    
            const result = await setSetting(settingName, processedValue);
            if (result.success) {
                logActivity(client, `Bot setting **${settingName}** changed to ${value} by [ **${interaction.user.tag}** ]`);
                interaction.reply({ 
                    content: `Setting **${settingName}** has been updated to: ${value}`, 
                    ephemeral: true 
                });
            } else {
                interaction.reply({ 
                    content: `Error updating setting: ${result.message}`, 
                    ephemeral: true 
                });
            }
        } catch (error) {
            interaction.reply({ 
                content: error.message, 
                ephemeral: true 
            });
        }
    }
    
    

module.exports = {
    data: commandData,
    execute
};