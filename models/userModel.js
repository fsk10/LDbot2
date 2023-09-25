module.exports = (sequelize) => {
    const { DataTypes, Model } = require('sequelize');

    class User extends Model {}

    User.init(
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
            nickname: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: true
            },
            firstname: {
                type: DataTypes.STRING,
                allowNull: false
            },
            lastname: {
                type: DataTypes.STRING,
                allowNull: false
            },
            country: {
                type: DataTypes.STRING,
                allowNull: false
            },
            email: {
                type: DataTypes.STRING,
                allowNull: false,
                unique: true,
                validate: {
                    isEmail: true
                }
            }
        },
        {
            sequelize,
            timestamps: true,
            freezeTableName: true,
            underscored: true,
            modelName: 'user',
            tableName: 'users'
        }
    );

    return User;
};
