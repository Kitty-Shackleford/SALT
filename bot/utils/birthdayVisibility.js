'use strict';

/**
 * Visibility rules for birthday data.
 *
 * `visibility` is the owner's choice for what non-owner viewers see:
 *   'char_only' — only the in-character age
 *   'irl_date'  — IRL month/day in addition
 *   'full'      — IRL age (year) in addition
 *
 * 'owner' (the birthday owner themself) and 'mod' (guild moderators, who may
 * see IRL data for roster/trust purposes) always see the IRL date; the IRL
 * age is only computable when irl_year is set.
 *
 * @param {string} view - unused view identifier (kept for symmetry)
 * @param {object} context { visibility, role: 'owner'|'mod'|'stranger', birthday }
 */
function birthdayVisibility(view, { visibility, role, birthday } = {}) {
  const result = { showCharAge: false, showIrlAge: false, showIrlDate: false };
  if (!birthday) return result;
  result.showCharAge = birthday.char_year != null;
  const hasIrlYear = birthday.irl_year != null;
  const level = visibility || 'char_only';
  if (role === 'owner' || role === 'mod' || level === 'full') {
    result.showIrlDate = true;
    result.showIrlAge = hasIrlYear;
  } else if (level === 'irl_date') {
    result.showIrlDate = true;
  }
  return result;
}

module.exports = { birthdayVisibility };
