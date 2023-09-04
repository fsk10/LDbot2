const { sequelize } = require('../database/database');
const EventModel = require('./eventModel')(sequelize);
const UserModel = require('./userModel')(sequelize);
const SettingsModel = require('./settingsModel')(sequelize);
const EventUsersModel = require('./eventUsersModel')(sequelize);

UserModel.belongsToMany(EventModel, { 
  through: EventUsersModel, 
  as: 'events',
  onDelete: 'CASCADE' // <-- Add this
});

EventModel.belongsToMany(UserModel, { 
  through: EventUsersModel, 
  as: 'users',
  onDelete: 'CASCADE' // <-- Add this
});

module.exports = {
  EventModel,
  UserModel,
  SettingsModel,
  EventUsersModel
};
