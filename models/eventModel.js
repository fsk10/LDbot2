module.exports = (sequelize) => {
  const { DataTypes, Model } = require('sequelize');

  class Event extends Model {}

  Event.init({
    id: {
      type: DataTypes.INTEGER,
      allowNull: false,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    location: {
      type: DataTypes.STRING
    },
    startdate: {
      type: DataTypes.DATE
    },
    enddate: {
      type: DataTypes.DATE
    },
    seatsavailable: {
      type: DataTypes.INTEGER
    },
    entryfee: {
      type: DataTypes.INTEGER
    },
    participantchannel: {
      type: DataTypes.STRING,
      allowNull: true
    },
    chartId: {
      type: DataTypes.STRING,
      allowNull: true
    },
    baseImagePath: {
      type: DataTypes.STRING,
      allowNull: true
    },
    paymentconfig: {
      type: DataTypes.STRING,
      allowNull: true
    },
    adminrole: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    regopen: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    logchannel: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    announcechannel: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Payment reminders (see scheduler/paymentReminders.js)
    reminderauto: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    reminderautosince: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    reminderfirstday: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 7,
    },
    remindersecondday: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 13,
    },
    paymentdays: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 14,
    },
    // ... add other fields as needed
  }, 
  {
    sequelize,
    timestamps: true,
    freezeTableName: true,
    modelName: 'event',
    tableName: 'events'
  });

  return Event;
}
