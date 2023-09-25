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
    // ... add other fields as needed
  }, 
  {
    sequelize,
    timestamps: true,
    freezeTableName: true,
    modelName: 'event',
    tableName: 'events'
  }
  );

  return Event;
}
