module.exports = (sequelize) => {
  const { Model, DataTypes } = require('sequelize');

  class Settings extends Model {}

  Settings.init({
    key: {
        type: DataTypes.STRING,
        primaryKey: true,
        allowNull: false
    },
    value: {
        type: DataTypes.TEXT,
        allowNull: false
    },
    description: {
        type: DataTypes.TEXT,
        allowNull: true
    },
    updatedAt: {
        type: DataTypes.DATE,
        allowNull: false
    },
    createdAt: {
        type: DataTypes.DATE,
        allowNull: false
    }
  }, {
    sequelize,
    modelName: 'Settings',
    tableName: 'settings',
    freezeTableName: true,
    timestamps: true
  });

  return Settings;
}