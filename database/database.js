const { Sequelize } = require('sequelize');
const logger = require('../utils/logger');
const settingsConfig = require('../config/settingsConfig');
const defaultSettings = Object.keys(settingsConfig);
const path = require('path');

const sequelize = new Sequelize({
    dialect: 'sqlite',
    logging: false,
    storage: path.join(__dirname, 'db.sqlite'),
    define: {
        timestamps: false,
        freezeTableName: true
    }
});


// Models
const Settings = require('../models/settingsModel')(sequelize);

// Initialization Logic
async function initializeDatabase() {
    // Synchronize the database
    await sequelize.sync()
        .then(() => {
            logger.info("Database initialized.");
            // Add any other minimal logic you want to run after initialization.
        })
        .catch(err => {
            logger.error("Error initializing the database:", err);
        });

    logger.info("[DB] All models were synchronized successfully.");

    // Initialization for settings
    logger.info("[DB] Initializing settings...");
    for (let settingName of defaultSettings) {
        logger.info(`[DB] Checking setting: ${settingName}`);
        await Settings.findOrCreate({
            where: { key: settingName },
            defaults: { value: "" }
        });
    }
    logger.info("[DB] Settings initialized.");
}

module.exports = {
    sequelize,
    initializeDatabase
};
