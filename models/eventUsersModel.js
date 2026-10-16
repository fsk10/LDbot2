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
      // When the user last became a participant (not reserve); the payment
      // deadline counts from here. Null while on the reserve list.
      participantsince: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Automatic payment reminders sent in the current participant period (0-2)
      remindersent: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
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

  // Keep participantsince in step with the reserve flag on every create/update,
  // whichever command or flow changes it. Static Model.update() skips these
  // hooks, so eventUsers rows must be updated through instances.
  function trackParticipantSince(row) {
    if (row.reserve) {
      row.participantsince = null;
      row.remindersent = 0;
    } else if (row.isNewRecord || row.changed('reserve') || !row.participantsince) {
      row.participantsince = new Date();
      row.remindersent = 0;
    }
  }
  EventUsers.addHook('beforeCreate', trackParticipantSince);
  EventUsers.addHook('beforeUpdate', trackParticipantSince);

  return EventUsers;
};
