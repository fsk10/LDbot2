const { SlashCommandBuilder } = require('@discordjs/builders');
const { getSetting } = require('../../database/operations');
const settingsConfig = require('../../config/settingsConfig');
const { getNameFromID } = require('../../utils/getNameFromID');
const { isAdmin } = require('../../utils/permissions');


const settingChoices = Object.keys(settingsConfig).map(setting => ({ name: setting, value: setting }));

const commandData = new SlashCommandBuilder()
    .setName('adminget')
    .setDescription('Retrieves the current value of a specific admin setting.')
    .addStringOption(option => 
        option.setName('setting')
            .setDescription('Name of the setting to retrieve.')
            .setRequired(true)
            .addChoices(...settingChoices)
    );

async function execute(interaction) {

    // Check if the user has admin permissions
    const userIsAdmin = await isAdmin(interaction);
    
    if (!userIsAdmin) {
        // Inform the user that they don't have the required permissions
        return interaction.reply({
            content: 'You don\'t have the required permissions to use this command.',
            ephemeral: true
        });
    }

    const settingName = interaction.options.getString('setting');

    try {
        const retrievedSetting = await getSetting(settingName);
        let value = retrievedSetting.value  // Extract the value property if it exists

        // If the setting has not been set yet
        if (!value) {
            return interaction.reply({ content: `The setting **${settingName}** has not been set yet.`, ephemeral: true });
        }

        // If the value is a role or channel ID, convert it to a mentionable format.
        const nameResult = await getNameFromID(interaction, value);
        if (nameResult) {
            value = nameResult.name;
        } else {
            // Handle the case where neither role nor channel was found (you can decide what to do here)
            value = 'Invalid ID';
        }

        interaction.reply({ content: `Current value for setting **${settingName}**: ${value}`, ephemeral: true });
    } catch (error) {
        interaction.reply({ content: error.message, ephemeral: true });
    }
}

module.exports = {
    data: commandData,
    execute
};
