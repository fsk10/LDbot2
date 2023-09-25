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
        })
        .catch(err => {
            logger.error("Error initializing the database:", err);
        });

    // Initialization for settings
    for (let settingName of defaultSettings) {
        await Settings.findOrCreate({
            where: { key: settingName },
            defaults: { value: "" }
        });
    }
}

module.exports = {
    sequelize,
    initializeDatabase
};
