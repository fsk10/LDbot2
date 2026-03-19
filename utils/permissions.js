// utils/permissions.js
const { getSetting } = require('../database/operations');
const { BOT_OWNER_ID } = require('../config.json');
const { EventModel } = require('../models');

function extractRoleIds(str) {
  if (!str) return [];
  // allow "<@&123>", "123", "Role Name", comma/space separated
  const parts = String(str).split(/[, ]+/).map(s => s.trim()).filter(Boolean);
  const ids = new Set();
  for (const p of parts) {
    const m = p.match(/(\d{15,25})/); // discord snowflake
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

async function isAdmin(interaction) {
  // 1) Bot owner always allowed
  if (interaction.user?.id === BOT_OWNER_ID) return true;

  // 2) Discord "Administrator" permission
  if (interaction.memberPermissions?.has?.('Administrator')) return true;

  // 3) Settings: adminRole (can contain one or many)
  const adminRoleSetting = await getSetting('adminRole'); // may return row or raw string depending on your ops
  const raw = adminRoleSetting?.value ?? adminRoleSetting ?? '';
  const roleIds = extractRoleIds(raw);

  const member = interaction.member;
  if (!member) return false;

  // Prefer ID match (reliable)
  if (roleIds.length && member.roles?.cache?.some(r => roleIds.includes(r.id))) return true;

  // Optional: fallback to name matching if no IDs found in setting
  if (!roleIds.length && raw) {
    const names = String(raw).split(/[,]+/).map(s => s.trim()).filter(Boolean);
    if (names.length && member.roles?.cache?.some(r => names.includes(r.name))) return true;
  }

  return false;
}

async function isEventAdminForEvent(interaction, eventId) {
  try {
    if (!interaction.inGuild?.() || !interaction.member) return false;
    const ev = await EventModel.findByPk(eventId);
    if (!ev?.adminrole) return false; // no role configured
    const roleId = String(ev.adminrole).match(/\d{5,}/)?.[0]; // handle raw ID or <@&id>
    if (!roleId) return false;
    return interaction.member.roles.cache.has(roleId);
  } catch {
    return false;
  }
}

module.exports = {
  isAdmin,
  isEventAdminForEvent, 
};
