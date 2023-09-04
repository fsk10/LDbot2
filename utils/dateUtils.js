const { DateTime } = require('luxon');
const logger = require('./logger');

function timeZoneNameToAbbr(timeZoneName) {
    const mapping = {
        "Central European Summer Time": "CEST",
        "Central European Time": "CET"
        // Add more mappings if needed
    };

    return mapping[timeZoneName] || timeZoneName;
}

function formatDisplayDate(dateString) {
    const dt = DateTime.fromJSDate(new Date(dateString)).setZone('Europe/Stockholm');
    if (!dt.isValid) {
        logger.error(`Invalid date string received: ${dateString}`);
        logger.error(`Reason for invalid date: ${dt.invalidReason}`);
        logger.error(`Explanation for invalid date: ${dt.invalidExplanation}`);
        return "Invalid DateTime";
    }

    // Extract timezone abbreviation from native Date
    const timeZoneName = new Date().toString().split('(')[1]?.split(')')[0] || "Unknown TZ";
    const timeZoneAbbr = timeZoneNameToAbbr(timeZoneName);

    return `${dt.toFormat('yyyy-MM-dd HH:mm')} ${timeZoneAbbr}`;
}

module.exports = formatDisplayDate;
