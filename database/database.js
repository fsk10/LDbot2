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

// One seat can only belong to one user per event. Older databases may already
// have such an index under another name (idx_eventusers_event_seat_unique from
// a manual migration). Skipped (with a warning) if the table already holds
// duplicates, so startup never fails because of it.
const SEAT_INDEX = 'eventusers_event_seat_unique';

async function ensureUniqueSeatIndex() {
  const [indexes] = await sequelize.query("PRAGMA index_list('eventUsers')");
  for (const index of indexes.filter(i => i.unique)) {
    const [columns] = await sequelize.query(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`);
    if (columns.map(c => c.name).join(',') === 'eventId,seat') return;
  }

  const [duplicates] = await sequelize.query(
    'SELECT eventId, seat, COUNT(*) AS n FROM eventUsers WHERE seat IS NOT NULL GROUP BY eventId, seat HAVING n > 1'
  );
  if (duplicates.length) {
    const list = duplicates.map(d => `event ${d.eventId} seat ${d.seat} (${d.n} users)`).join(', ');
    logger.warn(`Database: unique seat index NOT created, duplicate seats exist: ${list}. Fix them and restart.`);
    return;
  }

  await sequelize.query(`CREATE UNIQUE INDEX ${SEAT_INDEX} ON eventUsers (eventId, seat) WHERE seat IS NOT NULL`);
  logger.info(`Database: added unique index ${SEAT_INDEX}.`);
}

async function initializeDatabase() {
  try {
    const alter = false; // toggle for database ALTER logic on startup
    await sequelize.sync({ alter });
    await addMissingColumns();
    await ensureUniqueSeatIndex().catch(err => logger.warn(`Database: could not check unique seat index: ${err.message}`));
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
