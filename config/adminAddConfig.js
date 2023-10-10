const countryList = require('./countryList');

module.exports = {
    event: [
        {
            name: 'name',
            description: 'Name of the event',
            type: 'STRING',
            required: true,
            extractionMethod: 'getString'
        },
        {
            name: 'location',
            description: 'Location of the event',
            type: 'STRING',
            required: true,
            extractionMethod: 'getString'
        },
        {
            name: 'startdate',
            description: 'Start date and time of the event (Format: YYYY-MM-DD HH:mm)',
            type: 'STRING',
            required: true,
            extractionMethod: 'getString'
        },
        {
            name: 'enddate',
            description: 'End date and time of the event (Format: YYYY-MM-DD HH:mm)',
            type: 'STRING',
            required: true,
            extractionMethod: 'getString'
        },
        {
            name: 'seatsavailable',
            description: 'Number of seats available',
            type: 'INTEGER',
            required: true,
            extractionMethod: 'getInteger'
        },
        {
            name: 'entryfee',
            description: 'Entry fee for the event',
            type: 'INTEGER',
            required: true,
            extractionMethod: 'getInteger'
        },
        {
            name: 'participantchannel',
            description: 'Channel for participants list',
            type: 'STRING',
            required: false,
            extractionMethod: 'getString'
        },
    ],
    user: [
        {
            type: 'INTEGER',
            name: 'event',
            description: 'Event to add user to',
            required: true,
            extractionMethod: 'getInteger'
        },
        {
            name: 'discorduser',
            description: 'Discord username',
            type: 'USER',
            required: true,
            extractionMethod: 'getUser'
        },
        {
            name: 'nickname',
            description: 'Gaming nickname of user',
            type: 'STRING',
            required: true,
            extractionMethod: 'getString'
        },
        {
            name: 'firstname',
            description: 'Firstname of user',
            type: 'STRING',
            required: true,
            extractionMethod: 'getString'
        },
        {
            name: 'lastname',
            description: 'Lastname of user',
            type: 'STRING',
            required: true,
            extractionMethod: 'getString'
        },
        {
            name: 'country',
            description: 'Country of residence',
            type: 'STRING',
            required: true,
            choices: countryList,
            extractionMethod: 'getString'
        },
        {
            name: 'email',
            description: 'E-mail address',
            type: 'STRING',
            required: true,
            extractionMethod: 'getString'
        },
        {
            name: 'haspaid',
            description: 'Specify if user has paid the entry fee or not',
            type: 'BOOLEAN',
            required: true,
            extractionMethod: 'getBoolean'
        },
        {
            name: 'seat',
            description: 'Assigned seat for the user',
            type: 'INTEGER',
            required: false,
            extractionMethod: 'getInteger'
        },
        {
            name: 'reserve',
            description: 'Specify if user is a reserve',
            type: 'BOOLEAN',
            required: false,
            extractionMethod: 'getBoolean'
        }
    ]
};