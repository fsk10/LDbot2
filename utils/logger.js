const { createLogger, format, transports } = require('winston');
const fs = require('fs');
const path = require('path');

// Define the log directory path
const logDirectory = path.join(__dirname, '..', 'logs');

// Ensure the log directory exists
if (!fs.existsSync(logDirectory)) {
    fs.mkdirSync(logDirectory);
}

// Adjust the timestamp to use CET and desired format
const appendTimestamp = format((info, opts) => {
    if (opts.tz) {
        let date = new Date();
        let year = date.getUTCFullYear();
        let month = String(date.getUTCMonth() + 1).padStart(2, '0');
        let day = String(date.getUTCDate()).padStart(2, '0');
        let hours = String(date.getUTCHours()).padStart(2, '0');
        let minutes = String(date.getUTCMinutes()).padStart(2, '0');
        let seconds = String(date.getUTCSeconds()).padStart(2, '0');

        info.timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
    return info;
});

// Formats

const errorObjectFormat = format(info => {
    if (info instanceof Error) {
        return Object.assign({
            message: `${info.message} \n${info.stack}`
        }, info);
    }
    return info;
});


const consoleFormat = format.combine(
    errorObjectFormat(),
    format.colorize(),
    appendTimestamp({ tz: 'Europe/Stockholm' }),
    format.printf(({ level, message, timestamp }) => {
        return `${level}: [${timestamp}] ${message}`;
    })
);

const fileFormat = format.combine(
    errorObjectFormat(),
    appendTimestamp({ tz: 'Europe/Stockholm' }),
    format.printf(({ level, message, timestamp }) => {
        return `${level}: [${timestamp}] ${message}`;
    })
);


// Create a logger
const logger = createLogger({
    level: 'info',
    transports: [
        new transports.Console({ format: consoleFormat }),
        new transports.File({ filename: path.join(logDirectory, 'app.log'), format: fileFormat })
    ]
});

module.exports = logger;
