const { Sequelize, DataTypes } = require('sequelize');
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

// Columns added after a table was first created. sync() never adds columns to
// existing tables, and alter: true rebuilds tables in SQLite, so add them here.
const ADDED_COLUMNS = {
  events: {
    logchannel: { type: DataTypes.STRING, allowNull: true },
    announcechannel: { type: DataTypes.STRING, allowNull: true },
  },
};

async function addMissingColumns() {
  const queryInterface = sequelize.getQueryInterface();
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = await queryInterface.describeTable(table);
    for (const [column, definition] of Object.entries(columns)) {
      if (!existing[column]) {
        await queryInterface.addColumn(table, column, definition);
        logger.info(`Database: added column ${table}.${column}.`);
      }
    }
  }
}

async function initializeDatabase() {
  try {
    const alter = false; // toggle for database ALTER logic on startup
    await sequelize.sync({ alter });
    await addMissingColumns();
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
