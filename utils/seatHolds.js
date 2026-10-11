// utils/seatHolds.js
// A seat is held for a user from the moment they pick it until they confirm,
// cancel or pick again, at most SEAT_HOLD_MS. The hold lives in the user's
// TemporaryRegistration row (stage + seat + updatedAt), so it needs no cleanup:
// it simply stops counting once it is too old.
const { Op } = require('sequelize');
const { TemporaryRegistration } = require('../models');

const SEAT_HOLD_MS = 5 * 60 * 1000;
const SEAT_HOLD_MINUTES = SEAT_HOLD_MS / 60000;

// Seat ids (as strings) currently held by other users for this event.
async function getHeldSeats(eventId, exceptDiscordUser = null) {
    const where = {
        eventId,
        stage: 'showingConfirmation',
        seat: { [Op.ne]: null },
        updatedAt: { [Op.gte]: new Date(Date.now() - SEAT_HOLD_MS) },
    };
    if (exceptDiscordUser) where.discorduser = { [Op.ne]: exceptDiscordUser };

    const rows = await TemporaryRegistration.findAll({ where, attributes: ['seat'] });
    return new Set(rows.map(r => String(r.seat)));
}

module.exports = { getHeldSeats, SEAT_HOLD_MINUTES };
