const { Sequelize } = require('sequelize');
const path = require('path');
const logger = require('../utils/logger');
const settingsConfig = require('../config/settingsConfig');
const defaultSettings = Object.keys(settingsConfig);

const sequelize = new Sequelize({
  dialect: 'sqlite',
  logging: false,
  storage: path.join(__dirname, 'db.sqlite'),
  define: {
    timestamps: false,
    freezeTableName: true
  }
});

const Settings = require('../models/settingsModel')(sequelize);

async function initializeDatabase() {
  try {
    const alter = false; // toggle for database ALTER logic on startup
    await sequelize.sync({ alter });
    logger.info(`Database initialized${alter ? ' (alter mode ON)' : ''}.`);
  } catch (err) {
    logger.error('Error initializing the database:', err);
    throw err;
  }

  // Seed settings rows
  for (const settingName of defaultSettings) {
    await Settings.findOrCreate({
      where: { key: settingName },
      defaults: { value: '' }
    });
  }
}

module.exports = {
  sequelize,
  initializeDatabase
};
