module.exports = (sequelize) => {
  const { DataTypes, Model } = require('sequelize');

  class EventUsers extends Model {}

  EventUsers.init(
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      userId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'users', key: 'id' },
      },
      eventId: {
        type: DataTypes.INTEGER,
        allowNull: false,
        references: { model: 'events', key: 'id' },
      },
      seat: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      haspaid: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      paidAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      preferredseats: {
        type: DataTypes.STRING,
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING,
        allowNull: false,
        defaultValue: 'available',
      },
      reserve: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
    },
    {
      sequelize,
      modelName: 'EventUsers',
      tableName: 'eventUsers',
      freezeTableName: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['userId', 'eventId'] },
        { fields: ['eventId', 'seat'] },
      ],
    }
  );

  return EventUsers;
};
