const { sequelize } = require('../database/database');
const EventModel = require('./eventModel')(sequelize);
const UserModel = require('./userModel')(sequelize);
const SettingsModel = require('./settingsModel')(sequelize);
const EventUsersModel = require('./eventUsersModel')(sequelize);
const TemporaryRegistrationModel = require('./TemporaryRegistration')(sequelize);

UserModel.belongsToMany(EventModel, { 
  through: EventUsersModel, 
  as: 'events',
  onDelete: 'CASCADE'
});

EventModel.belongsToMany(UserModel, { 
  through: EventUsersModel, 
  as: 'users',
  onDelete: 'CASCADE'
});

EventUsersModel.belongsTo(UserModel, {
  foreignKey: 'userId',
  as: 'user'
});

EventUsersModel.belongsTo(EventModel, {
  foreignKey: 'eventId',
  as: 'event'
});

module.exports = {
  EventModel,
  UserModel,
  SettingsModel,
  EventUsersModel,
  TemporaryRegistration: TemporaryRegistrationModel
};
