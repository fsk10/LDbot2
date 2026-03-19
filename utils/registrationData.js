// utils/registrationData.js
const { TemporaryRegistration, UserModel } = require('../models');

/**
 * Build a normalized snapshot for a discord user.
 * Preference order: TemporaryRegistration overrides UserModel.
 * Returns simple strings (or '—') ready to drop into embeds.
 */
async function getRegistrationSnapshot(discordUserId) {
  // temp row (if any)
  const temp = await TemporaryRegistration.findOne({ where: { discorduser: discordUserId } });
  // persisted user (if any)
  const user = await UserModel.findOne({ where: { discorduser: discordUserId } });

  // helper: pick temp > user > fallback
  const pick = (key, fallback = '—') => {
    if (temp && temp[key] != null && temp[key] !== '') return String(temp[key]);
    if (user && user[key] != null && user[key] !== '') return String(user[key]);
    return fallback;
  };

  const snapshot = {
    discordUserId,
    nickname: pick('nickname'),
    firstname: pick('firstname'),
    lastname:  pick('lastname'),
    email:     pick('email'),
    country:   pick('country', ''), // empty means "no flag"
    seat:      pick('seat', ''),    // may be empty during flow
    reserve:   (temp?.reserve ?? false),
    // include the raw temp row in case callers need stage/eventId etc.
    _temp: temp || null,
    _user: user || null,
  };

  return snapshot;
}

module.exports = { getRegistrationSnapshot };
