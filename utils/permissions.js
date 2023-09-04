const { getSetting } = require('../database/operations');
const { BOT_OWNER_ID } = require('../config.json');

async function isAdmin(interaction) {
    // Check if the user is the bot owner
    if (interaction.user.id === BOT_OWNER_ID) {
        return true;
    }

    // Otherwise, check for the admin role
    const adminRole = await getSetting('adminRole');
    if (!adminRole) {
        return false; // If there's no admin role set, return false
    }
    const member = interaction.member;
    return member.roles.cache.has(adminRole.value || adminRole);
}

module.exports = { isAdmin };