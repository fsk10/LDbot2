const logger = require('../utils/logger');

function getNameFromID(interaction, id) {
    // Strip any mention markers from the ID
    id = id.replace(/<@&|<#|>/g, '');

    const user = interaction.client.users.cache.get(id);
    if (user) {
        return { type: 'user', name: user.username };
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
