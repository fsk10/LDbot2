const handleRoleSetting = (value) => {
    const roleId = value.match(/<@&(\d+)>/)?.[1];
    if (!roleId) {
        throw new Error('Invalid role mention.');
    }
    return roleId;
};

const handleChannelSetting = (value) => {
    const channelId = value.match(/<#(\d+)>/)?.[1];
    if (!channelId) {
        throw new Error('Invalid channel mention.');
    }
    return channelId;
};

const handleBooleanSetting = (value) => {
    return value === 'true' || value === '1'; // Convert to boolean
};

function processSetting(settingName, value) {
    // Check if value is in role mention format
    if (value.startsWith('<@&') && value.endsWith('>')) {
        return value.slice(3, -1);
    }
    // Check if value is in channel mention format
    else if (value.startsWith('<#') && value.endsWith('>')) {
        return value.slice(2, -1);
    }
    return value;
}

module.exports = { processSetting };
