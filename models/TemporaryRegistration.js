module.exports = (sequelize) => {
    const { DataTypes, Model } = require('sequelize');

    class TempRegistration extends Model {}

    TempRegistration.init(
        {
            id: {
                type: DataTypes.INTEGER,
                allowNull: false,
                primaryKey: true,
                autoIncrement: true
            },
            discorduser: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: true
            },
            stage: {
                type: DataTypes.STRING,
                allowNull: false
            },
            event: {
                type: DataTypes.STRING,
                allowNull: true
            },
            eventId: {
                type: DataTypes.INTEGER,
                allowNull: true
            },
            nickname: {
                type: DataTypes.STRING,
                allowNull: true
            },
            firstname: {
                type: DataTypes.STRING,
                allowNull: true
            },
            lastname: {
                type: DataTypes.STRING,
                allowNull: true
            },
            email: {
                type: DataTypes.STRING,
                allowNull: true,
                validate: {
                    isEmail: true
                }
            },
            country: {
                type: DataTypes.STRING,
                allowNull: true
            },
            unconfirmedCountry: {
                type: DataTypes.STRING(2),
                allowNull: true
            },
            seat: {
                type: DataTypes.INTEGER,
                allowNull: true
            },
            preferredSeats: {
                type: DataTypes.STRING, 
                allowNull: true
            }
        },
        {
            sequelize,
            timestamps: true,
            freezeTableName: true,
            underscored: true,
            modelName: 'tempRegistration',
            tableName: 'tempRegistrations'
        }
    );

    return TempRegistration;
};
