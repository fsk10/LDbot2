const logger = require('../utils/logger');

async function getNameFromID(interaction, id) {
    // Strip any mention markers from the ID
    id = id.replace(/<@&|<#|>/g, '');

    try {
        const fetchedUser = await interaction.client.users.fetch(id);
        if (fetchedUser) {
            return { type: 'user', name: fetchedUser.username };
        }
    } catch (error) {
        logger.error(`Failed to directly fetch user with ID: ${id}. Error: ${error.message}`);
    }

    const role = interaction.guild.roles.cache.get(id);
    if (role) {
        return { type: 'role', name: `<@&${role.id}>` };
    }

    const channel = interaction.guild.channels.cache.get(id);
    if (channel) {
        return { type: 'channel', name: `<#${channel.id}>` };
    }

    logger.error(`Failed to fetch name for ID: ${id}. It's neither a valid role, channel, nor a user.`);
    return null;
}

module.exports = {
    getNameFromID
};
