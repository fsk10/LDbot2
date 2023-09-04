const logger = require('./logger');

module.exports = function(optionName, interaction, extractionMethod) {
    try {
        if (extractionMethod === 'getString') {
            return interaction.options.getString(optionName);
        } else if (extractionMethod === 'getInteger') {
            return interaction.options.getInteger(optionName);
        } else if (extractionMethod === 'getUser') {
            const userObj = interaction.options.getUser(optionName);
            return userObj.id;
        } else if (extractionMethod === 'getBoolean') {
            return interaction.options.getBoolean(optionName);
        }
    } catch (error) {
        logger.error(`Error extracting option "${optionName}" using method "${extractionMethod}":`, error);
        return `Invalid ${extractionMethod.replace('get', '')}`;
    }
};
