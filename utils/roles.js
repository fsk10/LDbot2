// utils/roles.js
const { Collection } = require('discord.js');

/** Extract a Discord snowflake from an id or mention. */
function extractSnowflake(input) {
  if (!input) return null;
  const m = String(input).match(/\d{15,25}/);
  return m ? m[0] : null;
}

/**
 * Resolve a role by:
 *  - Role object
 *  - ID (snowflake)
 *  - <@&mention>
 *  - Exact name (case-insensitive) from cache
 *
 * @param {import('discord.js').Guild} guild
 * @param {string|object} input
 * @returns {Promise<{role: import('discord.js').Role, id: string} | null>}
 */
async function resolveRole(guild, input) {
  if (!guild || !input) return null;

  // 1) Already a Role object?
  if (typeof input === 'object' && input.id && input.name) {
    return { role: input, id: input.id };
  }

  const raw = String(input).trim();
  if (!raw) return null;

  // 2) Try snowflake / mention
  const sf = extractSnowflake(raw);
  if (sf) {
    const fromCache = guild.roles.cache.get(sf);
    if (fromCache) return { role: fromCache, id: fromCache.id };
    try {
      const fetched = await guild.roles.fetch(sf);
      if (fetched) return { role: fetched, id: fetched.id };
    } catch (_) {}
  }

  // 3) Fallback: exact name (case-insensitive) from cache
  const byName = guild.roles.cache.find(r => r.name.toLowerCase() === raw.toLowerCase());
  if (byName) return { role: byName, id: byName.id };

  return null;
}

/**
 * Pretty print a stored role id; returns:
 *  - "Role Name (@mention)" if found
 *  - "(missing role) — <id>" if not found
 */
async function prettyRoleFromId(guild, roleId) {
  if (!guild || !roleId) return '—';
  const inCache = guild.roles.cache.get(roleId);
  if (inCache) return `${inCache.name} (<@&${inCache.id}>)`;
  try {
    const fetched = await guild.roles.fetch(roleId);
    if (fetched) return `${fetched.name} (<@&${fetched.id}>)`;
  } catch (_) {}
  return `(missing role) — ${roleId}`;
}

module.exports = {
  resolveRole,
  prettyRoleFromId,
  extractSnowflake,
};
