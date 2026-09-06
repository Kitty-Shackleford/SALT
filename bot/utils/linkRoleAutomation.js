'use strict';

function roleChangesForPhase(settings, phase) {
  const roles = settings?.roles || {};
  if (phase === 'join') {
    return { add: roles.assignOnJoin || [], remove: [] };
  }
  if (phase === 'link') {
    return {
      add: roles.assignOnLink || [],
      remove: roles.removeOnLink || [],
    };
  }
  if (phase === 'leave') {
    return { add: [], remove: roles.removeOnLeave || [] };
  }
  throw new Error(`Unsupported link role lifecycle phase: ${phase}`);
}

async function applyLinkRoleAutomation(member, settings, phase) {
  if (!member?.roles) return;
  const changes = roleChangesForPhase(settings, phase);
  const add = [...new Set(changes.add.map(String).filter(Boolean))];
  const remove = [...new Set(changes.remove.map(String).filter(Boolean))]
    .filter(roleId => !add.includes(roleId));

  if (add.length) await member.roles.add(add, `DayZ player-link automation: ${phase}`);
  if (remove.length) await member.roles.remove(remove, `DayZ player-link automation: ${phase}`);
}

module.exports = { roleChangesForPhase, applyLinkRoleAutomation };
