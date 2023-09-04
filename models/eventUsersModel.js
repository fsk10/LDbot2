module.exports = (sequelize) => {
    const { DataTypes, Model } = require('sequelize');

    class EventUsers extends Model {}

    EventUsers.init({
        userId: {
            type: DataTypes.INTEGER,
            references: {
                model: 'users',
                key: 'id'
            }
        },
        eventId: {
            type: DataTypes.INTEGER,
            references: {
                model: 'events',
                key: 'id'
            }
        },
        seat: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        haspaid: {
            type: DataTypes.BOOLEAN,
            allowNull: true,
            defaultValue: false
        },
        preferredseats: {
            type: DataTypes.STRING,
            allowNull: true
        }
    }, {
        sequelize,
        timestamps: true,
        modelName: 'EventUsers',
        tableName: 'eventUsers',
        freezeTableName: true
    });

    return EventUsers;
};
