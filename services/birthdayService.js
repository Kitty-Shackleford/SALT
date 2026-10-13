'use strict';

/**
 * Birthday service — IRL + in-character birthdays keyed on identity so
 * alts under the same human never double-announce.
 *
 * DB notes: player_identities.id and guilds.id are INTEGER
 * (GENERATED ALWAYS AS IDENTITY) in this schema, so the birthday tables
 * reference them with INTEGER.
 *
 * The `pg` driver returns INTEGER columns as strings, so every numeric
 * field is coerced through toInt() before arithmetic or comparisons.
 */

const VISIBILITIES = new Set(['char_only', 'irl_date', 'full']);

function toInt(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function birthdayError(message) {
  const error = new Error(message);
  error.code = 'BIRTHDAY_INVALID';
  return error;
}

/**
 * Validate a birthday before persisting it.
 * Month/day validity uses a real Date check anchored at the leap year 2000,
 * so Feb 29 is accepted and Feb 30 / Apr 31 etc. are rejected.
 */
function validateBirthday({ month, day, irlYear = null, charYear = null, visibility = 'char_only' } = {}) {
  const m = toInt(month);
  const d = toInt(day);
  if (m == null || m < 1 || m > 12) {
    throw birthdayError('Month must be an integer between 1 and 12.');
  }
  if (d == null || d < 1 || d > 31) {
    throw birthdayError('Day must be an integer between 1 and 31.');
  }
  const probe = new Date(2000, m - 1, d);
  if (probe.getFullYear() !== 2000 || probe.getMonth() !== m - 1 || probe.getDate() !== d) {
    throw birthdayError(`That month does not have day ${d}.`);
  }
  for (const [label, value] of [['IRL birth year', irlYear], ['Character birth year', charYear]]) {
    if (value == null || value === '') continue;
    const y = toInt(value);
    if (y == null || y < 1900 || y > 2100) {
      throw birthdayError(`${label} must be a whole year between 1900 and 2100.`);
    }
  }
  if (!VISIBILITIES.has(visibility)) {
    throw birthdayError('Visibility must be one of: char_only, irl_date, full.');
  }
  return true;
}

/** Compute ages from stored years relative to the business date (YYYY-MM-DD). */
function computeAges({ irl_year, char_year }, businessDate) {
  const year = toInt(String(businessDate).slice(0, 4));
  const irlYear = toInt(irl_year);
  const charYear = toInt(char_year);
  return {
    irlAge: irlYear != null && year != null ? Math.max(0, year - irlYear) : null,
    charAge: charYear != null && year != null ? Math.max(0, year - charYear) : null,
  };
}

/** Fetch one identity's birthday row (or null). */
async function getBirthday(db, identityId) {
  return db.get(
    `SELECT identity_id, month, day, irl_year, char_year, visibility, active, created_at, updated_at
     FROM player_birthdays
     WHERE identity_id = ?`,
    [toInt(identityId)]
  );
}

/**
 * Insert or update an identity's birthday.
 * @returns the stored row
 */
async function setBirthday(db, { identityId, month, day, irlYear = null, charYear = null, visibility = 'char_only' }) {
  validateBirthday({ month, day, irlYear, charYear, visibility });
  const m = toInt(month);
  const d = toInt(day);
  const iy = irlYear == null || irlYear === '' ? null : toInt(irlYear);
  const cy = charYear == null || charYear === '' ? null : toInt(charYear);
  await db.transaction(async transactionDb => {
    await transactionDb.run(
      `INSERT INTO player_birthdays (identity_id, month, day, irl_year, char_year, visibility, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, TRUE, NOW())
       ON CONFLICT (identity_id) DO UPDATE SET
         month = EXCLUDED.month,
         day = EXCLUDED.day,
         irl_year = EXCLUDED.irl_year,
         char_year = EXCLUDED.char_year,
         visibility = EXCLUDED.visibility,
         active = TRUE,
         updated_at = NOW()`,
      [toInt(identityId), m, d, iy, cy, visibility]
    );
  });
  return getBirthday(db, identityId);
}

// Most recent current gamertag for the identity within the guild, falling
// back to the platform username.
const NAME_SUBQUERY = `
  COALESCE(
    (SELECT pg.gamertag
     FROM player_gamertags pg
     JOIN servers s ON s.id = pg.server_id
     WHERE pg.identity_id = pb.identity_id
       AND s.guild_id = ?
       AND pg.is_current_gamertag = 1
     ORDER BY pg.last_seen DESC NULLS LAST
     LIMIT 1),
    pi.platform_username
  )`;

const GUILD_SCOPE_EXISTS = `
  EXISTS (
    SELECT 1 FROM server_player_memberships spm
    WHERE spm.identity_id = pb.identity_id
      AND spm.guild_id = ?
      AND spm.status = 'active'
  )`;

/**
 * Guild-scoped identities with an active birthday on `date` (YYYY-MM-DD).
 * Rows include coerced irlAge/charAge via computeAges.
 */
async function collectTodaysBirthdays(db, { guildId, date }) {
  const rows = await db.query(
    `SELECT pb.identity_id,
            pb.month,
            pb.day,
            pb.irl_year,
            pb.char_year,
            pb.visibility,
            ${NAME_SUBQUERY} AS name
     FROM player_birthdays pb
     JOIN player_identities pi ON pi.id = pb.identity_id
     WHERE pb.active = TRUE
       AND EXTRACT(MONTH FROM ?::date) = pb.month
       AND EXTRACT(DAY FROM ?::date) = pb.day
       AND ${GUILD_SCOPE_EXISTS}
     ORDER BY pb.identity_id`,
    [guildId, date, date, guildId]
  );
  return rows.map(row => ({
    ...row,
    ...computeAges(row, date),
  }));
}

/**
 * Guild-scoped identities whose next birthday falls within `days` days
 * (0..31) of `today` (defaults to the current date). Rows include
 * `days_until`.
 *
 * `days_until_raw` comes back from PostgreSQL as an interval, so it is
 * parsed here into an integer number of days (the adapter does not cast
 * intervals to numbers).
 */
function parseIntervalDays(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  const text = String(value);
  const match = text.match(/(-?)(\d+)\s*d(?:ays?)?\s*(\d+)?/i);
  if (!match) return 0;
  const days = Number(match[2]);
  const sign = match[1] === '-' ? -1 : 1;
  return sign * days;
}

async function listUpcoming(db, { guildId, days, today = new Date().toISOString().slice(0, 10) }) {
  const windowDays = Math.min(Math.max(toInt(days) || 0, 0), 31);
  const rows = await db.query(
    `WITH today AS (SELECT ?::date AS d)
     SELECT pb.identity_id,
            pb.month,
            pb.day,
            pb.irl_year,
            pb.char_year,
            pb.visibility,
            ${NAME_SUBQUERY} AS name,
            (CASE
               WHEN make_date(CAST(EXTRACT(YEAR FROM today.d) AS INTEGER), pb.month, pb.day) < today.d
                 THEN make_date(CAST(EXTRACT(YEAR FROM today.d) AS INTEGER) + 1, pb.month, pb.day)
               ELSE make_date(CAST(EXTRACT(YEAR FROM today.d) AS INTEGER), pb.month, pb.day)
             END - today.d) AS days_until_raw
     FROM player_birthdays pb
     JOIN player_identities pi ON pi.id = pb.identity_id
     CROSS JOIN today
     WHERE pb.active = TRUE
       AND (CASE
              WHEN make_date(CAST(EXTRACT(YEAR FROM today.d) AS INTEGER), pb.month, pb.day) < today.d
                THEN make_date(CAST(EXTRACT(YEAR FROM today.d) AS INTEGER) + 1, pb.month, pb.day)
              ELSE make_date(CAST(EXTRACT(YEAR FROM today.d) AS INTEGER), pb.month, pb.day)
            END) BETWEEN today.d AND today.d + ?
       AND ${GUILD_SCOPE_EXISTS}
     ORDER BY days_until_raw, pb.identity_id`,
    [guildId, today, windowDays, guildId]
  );
  return rows.map(row => {
    const { days_until_raw, ...rest } = row;
    return { ...rest, days_until: parseIntervalDays(days_until_raw) };
  });
}

module.exports = {
  VISIBILITIES,
  toInt,
  parseIntervalDays,
  validateBirthday,
  computeAges,
  getBirthday,
  setBirthday,
  collectTodaysBirthdays,
  listUpcoming,
};
