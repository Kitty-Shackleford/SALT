'use strict';

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${error.message}`);
  }
}

// ─── Tiny in-memory db mimicking the dashboard adapter (query/get/run/transaction) ───

function fakeDb(state = {}) {
  const db = {
    calls: [],
    birthdays: state.birthdays || new Map(), // identityId -> row
    announcements: state.announcements || [], // [{ identity_id, guild_id, business_date }]
    guilds: state.guilds || [{ id: 1, discord_guild_id: '9001', birthday_announce_channel_id: null }],
    posted: state.posted || [],
    channels: state.channels || [],
    async get(sql, params) {
      db.calls.push({ method: 'get', sql, params });
      if (/FROM player_birthdays/i.test(sql)) {
        const id = Number(params[0]);
        return db.birthdays.get(id) || null;
      }
      if (/FROM guilds/i.test(sql)) return db.guilds[0] || null;
      if (/FROM guild_roles/i.test(sql) || /server_role_assignments/i.test(sql)) {
        return state.modRow || null;
      }
      return null;
    },
    async query(sql, params) {
      db.calls.push({ method: 'query', sql, params });
      if (/FROM guilds/i.test(sql)) return db.guilds;
      if (/FROM player_birthdays/i.test(sql)) {
        const date = String(params[1] || params[0]).slice(0, 10);
        const month = Number(date.slice(5, 7));
        const day = Number(date.slice(8, 10));
        const rows = [];
        for (const row of db.birthdays.values()) {
          if (row.active && Number(row.month) === month && Number(row.day) === day) rows.push(row);
        }
        return rows;
      }
      if (/FROM player_birthdays/i.test(sql) && /days_until_raw/i.test(sql)) return [];
      return [];
    },
    async run(sql, params) {
      db.calls.push({ method: 'run', sql, params });
      if (/INSERT INTO player_birthdays/i.test(sql)) {
        const [identityId, month, day, irlYear, charYear, visibility] = params;
        db.birthdays.set(Number(identityId), {
          identity_id: Number(identityId),
          month, day, irl_year: irlYear, char_year: charYear,
          visibility, active: true, name: state.names ? state.names[Number(identityId)] : 'Survivor'
        });
        return { changes: 1, lastID: Number(identityId) };
      }
      if (/INSERT INTO birthday_announcements/i.test(sql)) {
        const [identityId, guildId, businessDate] = params;
        const exists = db.announcements.some(a =>
          Number(a.identity_id) === Number(identityId)
          && Number(a.guild_id) === Number(guildId)
          && a.business_date === businessDate);
        if (exists) return { changes: 0 };
        db.announcements.push({ identity_id: Number(identityId), guild_id: Number(guildId), business_date: businessDate });
        return { changes: 1 };
      }
      return { changes: 1, lastID: 1 };
    },
    async transaction(fn) { return fn(db); }
  };
  return db;
}

function postingDb(state = {}) {
  const db = fakeDb(state);
  const post = async (channelId, embed) => {
    db.posted.push({ channelId, embed });
    return true;
  };
  const listChannels = async () => db.channels;
  return { db, post, listChannels, state };
}

(async () => {
  console.log('\nBirthday tracker tests');

  // ─── Migration shape ───
  await test('migration 097 creates both tables with the idempotency unique', async () => {
    const migration = require('../db/migrations/097_birthday_tracker');
    const statements = [];
    await migration.up({ async query(sql) { statements.push(sql); return { rows: [] }; } });
    const all = statements.join('\n');
    assert.match(all, /CREATE TABLE IF NOT EXISTS player_birthdays/);
    assert.match(all, /CREATE TABLE IF NOT EXISTS birthday_announcements/);
    assert.match(all, /UNIQUE \(identity_id, guild_id, business_date\)/);
    assert.match(all, /CHECK \(month BETWEEN 1 AND 12\)/);
    assert.match(all, /CHECK \(day BETWEEN 1 AND 31\)/);
    assert.match(all, /visibility IN \('char_only', 'irl_date', 'full'\)/);
    assert.match(all, /REFERENCES player_identities\(id\) ON DELETE CASCADE/);
    assert.match(all, /birthday_announce_channel_id/);
  });

  await test('migration 097 down drops everything it created', async () => {
    const migration = require('../db/migrations/097_birthday_tracker');
    const statements = [];
    await migration.down({ async query(sql) { statements.push(sql); return { rows: [] }; } });
    assert.match(statements.join('\n'), /DROP TABLE IF EXISTS birthday_announcements/);
    assert.match(statements.join('\n'), /DROP TABLE IF EXISTS player_birthdays/);
  });

  // ─── Service: validation ───
  const birthdayService = require('../services/birthdayService');

  await test('set rejects Feb 30 (real Date validity check, year 2000)', async () => {
    const db = fakeDb();
    await assert.rejects(
      birthdayService.setBirthday(db, { identityId: 1, month: 2, day: 30 }),
      /day 30/
    );
  });

  await test('set rejects April 31 and month 13', async () => {
    const db = fakeDb();
    await assert.rejects(
      birthdayService.setBirthday(db, { identityId: 1, month: 4, day: 31 }),
      /day 31/
    );
    await assert.rejects(
      birthdayService.setBirthday(db, { identityId: 1, month: 13, day: 1 }),
      /Month/
    );
  });

  await test('set accepts Feb 29 (leap year 2000 anchor)', async () => {
    const db = fakeDb();
    const row = await birthdayService.setBirthday(db, { identityId: 5, month: 2, day: 29, charYear: 2020 });
    assert.strictEqual(Number(row.month), 2);
    assert.strictEqual(Number(row.day), 29);
  });

  await test('set enforces ranges and year bounds', async () => {
    const db = fakeDb();
    await assert.rejects(birthdayService.setBirthday(db, { identityId: 1, month: 0, day: 1 }), /Month/);
    await assert.rejects(birthdayService.setBirthday(db, { identityId: 1, month: 1, day: 0 }), /Day/);
    await assert.rejects(birthdayService.setBirthday(db, { identityId: 1, month: 1, day: 1, irlYear: 1200 }), /between 1900 and 2100/);
    await assert.rejects(birthdayService.setBirthday(db, { identityId: 1, month: 1, day: 1, visibility: 'secret' }), /char_only, irl_date, full/);
  });

  await test('set upserts the same identity instead of inserting a second row', async () => {
    const db = fakeDb();
    await birthdayService.setBirthday(db, { identityId: 7, month: 6, day: 15, charYear: 2022, visibility: 'char_only' });
    await birthdayService.setBirthday(db, { identityId: 7, month: 6, day: 15, charYear: 2022, irlYear: 2000, visibility: 'full' });
    assert.strictEqual(db.birthdays.size, 1);
    const row = db.birthdays.get(7);
    assert.strictEqual(row.irl_year, 2000);
    assert.strictEqual(row.visibility, 'full');
  });

  await test('computeAges derives both ages from the business date', async () => {
    assert.deepStrictEqual(
      birthdayService.computeAges({ irl_year: '1990', char_year: '2021' }, '2026-10-07'),
      { irlAge: 36, charAge: 5 }
    );
    assert.deepStrictEqual(
      birthdayService.computeAges({ irl_year: null, char_year: null }, '2026-10-07'),
      { irlAge: null, charAge: null }
    );
  });

  // ─── Visibility matrix ───
  const { birthdayVisibility } = require('../bot/utils/birthdayVisibility');
  const entry = {
    month: 10, day: 7, irl_year: 1990, char_year: 2021, visibility: 'char_only'
  };

  await test('visibility: char_only hides IRL from strangers, shows char age', () => {
    const stranger = birthdayVisibility('view', { visibility: entry.visibility, role: 'stranger', birthday: entry });
    assert.strictEqual(stranger.showCharAge, true);
    assert.strictEqual(stranger.showIrlDate, false);
    assert.strictEqual(stranger.showIrlAge, false);
    const owner = birthdayVisibility('view', { visibility: entry.visibility, role: 'owner', birthday: entry });
    assert.strictEqual(owner.showIrlDate, true);
    assert.strictEqual(owner.showIrlAge, true);
  });

  await test('visibility: irl_date reveals month/day but not IRL age to strangers', () => {
    const stranger = birthdayVisibility('view', { visibility: 'irl_date', role: 'stranger', birthday: entry });
    assert.strictEqual(stranger.showIrlDate, true);
    assert.strictEqual(stranger.showIrlAge, false);
  });

  await test('visibility: full reveals IRL age to strangers; mod always sees IRL date', () => {
    const stranger = birthdayVisibility('view', { visibility: 'full', role: 'stranger', birthday: entry });
    assert.strictEqual(stranger.showIrlDate, true);
    assert.strictEqual(stranger.showIrlAge, true);
    const mod = birthdayVisibility('view', { visibility: 'char_only', role: 'mod', birthday: entry });
    assert.strictEqual(mod.showIrlDate, true);
    const modNoIrlYear = birthdayVisibility('view', { visibility: 'char_only', role: 'mod', birthday: { ...entry, irl_year: null } });
    assert.strictEqual(modNoIrlYear.showIrlDate, true);
    assert.strictEqual(modNoIrlYear.showIrlAge, false);
  });

  // ─── Worker: embed content ───
  const worker = require('../workers/birthdayAnnouncer');

  await test('embed: char year → survivor-years line, no IRL line for char_only', () => {
    const embed = worker.buildBirthdayEmbed({
      identity_id: 1, name: 'Walter', month: 10, day: 7,
      irl_year: 1990, char_year: 2021, visibility: 'char_only',
      irlAge: 36, charAge: 5
    });
    assert.match(embed.description, /\*\*Walter\*\* has survived \*\*5\*\* years in Chernarus/);
    assert.doesNotMatch(embed.description, /birthday!/);
  });

  await test('embed: IRL line appears only when visibility allows it', () => {
    const allowed = worker.buildBirthdayEmbed({
      identity_id: 1, name: 'Walter', month: 10, day: 7,
      irl_year: 1990, char_year: 2021, visibility: 'full', irlAge: 36, charAge: 5
    });
    assert.match(allowed.description, /Happy \*\*36\*\*\. birthday!/);
    const hidden = worker.buildBirthdayEmbed({
      identity_id: 1, name: 'Walter', month: 10, day: 7,
      irl_year: 1990, char_year: 2021, visibility: 'irl_date', irlAge: 36, charAge: 5
    });
    assert.doesNotMatch(hidden.description, /birthday!/);
  });

  await test('toDateOnly is local-calendar based', () => {
    const d = new Date(2026, 9, 7); // October 7, 2026 local
    assert.strictEqual(worker.toDateOnly(d), '2026-10-07');
  });

  // ─── Worker: channel fallback ───
  await test('channel: configured channel wins', async () => {
    const channelId = await worker.resolveAnnouncementChannel(
      { discord_guild_id: '9001', birthday_announce_channel_id: '555' },
      async () => { throw new Error('must not list'); }
    );
    assert.strictEqual(channelId, '555');
  });

  await test('channel: falls back to #general, then first text channel', async () => {
    const channels = [
      { id: '111', name: 'announcements', type: 0 },
      { id: '222', name: 'general', type: 0 },
      { id: '333', name: 'voice', type: 2 }
    ];
    const general = await worker.resolveAnnouncementChannel(
      { discord_guild_id: '9001', birthday_announce_channel_id: null },
      async () => channels
    );
    assert.strictEqual(general, '222');
    const firstText = await worker.resolveAnnouncementChannel(
      { discord_guild_id: '9001', birthday_announce_channel_id: null },
      async () => channels.filter(c => c.id !== '222')
    );
    assert.strictEqual(firstText, '111');
    const none = await worker.resolveAnnouncementChannel(
      { discord_guild_id: '9001', birthday_announce_channel_id: null },
      async () => [{ id: '333', name: 'voice', type: 2 }]
    );
    assert.strictEqual(none, null);
  });

  await test('channel: listing failure degrades to null, not a throw', async () => {
    const channelId = await worker.resolveAnnouncementChannel(
      { discord_guild_id: '9001', birthday_announce_channel_id: null },
      async () => { throw new Error('503'); }
    );
    assert.strictEqual(channelId, null);
  });

  // ─── Worker: dedupe across ticks on the same day ───
  await test('announce once: second pass on the same day posts nothing', async () => {
    const { db, post, listChannels } = postingDb({
      birthdays: (() => {
        const m = new Map();
        m.set(42, { identity_id: 42, month: 10, day: 7, irl_year: null, char_year: 2021, visibility: 'char_only', active: true, name: 'Rook' });
        return m;
      })(),
      channels: [{ id: '222', name: 'general', type: 0 }],
      names: { 42: 'Rook' }
    });
    const options = {
      today: new Date(2026, 9, 7),
      postMessage: post,
      listGuildChannels: listChannels,
      logger: { warn() {}, info() {} }
    };
    const first = await worker.announceBirthdays(db, options);
    assert.strictEqual(first.announced, 1);
    assert.strictEqual(db.posted.length, 1);
    assert.strictEqual(db.posted[0].channelId, '222');
    const second = await worker.announceBirthdays(db, options);
    assert.strictEqual(second.announced, 0);
    assert.strictEqual(db.posted.length, 1, 'no double-announce on the second pass');
  });

  await test('announce once across date rollover: a new date announces again', async () => {
    const { db, post, listChannels } = postingDb({
      birthdays: (() => {
        const m = new Map();
        m.set(42, { identity_id: 42, month: 10, day: 7, irl_year: null, char_year: 2021, visibility: 'char_only', active: true, name: 'Rook' });
        m.set(43, { identity_id: 43, month: 10, day: 8, irl_year: null, char_year: 2020, visibility: 'char_only', active: true, name: 'Mira' });
        return m;
      })(),
      channels: [{ id: '222', name: 'general', type: 0 }]
    });
    const optionsFor = day => ({
      today: new Date(2026, 9, day),
      postMessage: post,
      listGuildChannels: listChannels,
      logger: { warn() {}, info() {} }
    });
    assert.strictEqual((await worker.announceBirthdays(db, optionsFor(7))).announced, 1);
    assert.strictEqual((await worker.announceBirthdays(db, optionsFor(8))).announced, 1);
    assert.strictEqual(db.posted.length, 2);
    const dates = db.announcements.map(a => a.business_date).sort();
    assert.deepStrictEqual(dates, ['2026-10-07', '2026-10-08']);
  });

  // ─── Worker: scheduling wrapper (mirrors casinoExpiryProcessor test) ───
  await test('startBirthdayAnnouncer: injectable timers, unref, no-op on same day', async () => {
    let startupTask;
    let intervalTask;
    const warnings = [];
    const { db, post, listChannels } = postingDb({
      birthdays: (() => {
        const m = new Map();
        m.set(42, { identity_id: 42, month: 10, day: 7, irl_year: null, char_year: 2021, visibility: 'char_only', active: true, name: 'Rook' });
        return m;
      })(),
      channels: [{ id: '222', name: 'general', type: 0 }]
    });
    let now = new Date(2026, 9, 7);
    const handle = worker.startBirthdayAnnouncer(db, {
      startupDelayMs: 0,
      intervalMs: 60000,
      dateFn: () => now,
      postMessage: post,
      listGuildChannels: listChannels,
      setTimeoutFn(cb) { startupTask = cb; return { unref() {} }; },
      setIntervalFn(cb) { intervalTask = cb; return { unref() {} }; },
      clearTimeoutFn() {},
      clearIntervalFn() {},
      logger: { info() {}, warn(...a) { warnings.push(a); }, error() {} }
    });
    assert.strictEqual(typeof startupTask, 'function');
    assert.strictEqual(typeof intervalTask, 'function');
    const first = await startupTask();
    assert.strictEqual(first.announced, 1);
    const again = await startupTask(); // same date → skip
    assert.strictEqual(again.announced, 0);
    assert.strictEqual(again.skipped, 'same-day');
    now = new Date(2026, 9, 8);
    assert.strictEqual((await intervalTask()).announced, 0, 'no birthday on 10/08');
    assert.strictEqual(db.posted.length, 1);
    handle.stop();
  });

  await test('startBirthdayAnnouncer: a failing pass is contained, not fatal', async () => {
    const errors = [];
    const brokenDb = { async query() { throw new Error('db down'); } };
    const handle = worker.startBirthdayAnnouncer(brokenDb, {
      startupDelayMs: 0,
      intervalMs: 60000,
      dateFn: () => new Date(2026, 9, 7),
      setTimeoutFn() { return { unref() {} }; },
      setIntervalFn() { return { unref() {} }; },
      clearTimeoutFn() {},
      clearIntervalFn() {},
      logger: { info() {}, warn() {}, error(...a) { errors.push(a); } }
    });
    const result = await handle.run();
    assert.strictEqual(result.announced, 0);
    assert.strictEqual(errors.length, 1);
    // lastRunDate was not set, so the next day can still announce.
    handle.stop();
  });

  // ─── Scheduler wiring ───
  await test('economyScheduler wires the birthday worker in the same shape as casino expiry', () => {
    const schedulerSource = fs.readFileSync(path.join(root, 'utils', 'economyScheduler.js'), 'utf8');
    assert.match(schedulerSource, /startCasinoExpiryWorker\(db\)/);
    assert.match(schedulerSource, /startBirthdayAnnouncer\(db\)/);
  });

  // ─── Authorization classes ───
  await test('command classes classify every birthday subcommand', () => {
    const { COMMAND_CLASSES, commandAuthorizationKey } = require('../bot/utils/commandAuthorization');
    assert.strictEqual(commandAuthorizationKey('birthday', 'set'), 'birthday:set');
    assert.strictEqual(COMMAND_CLASSES['birthday:set'], 'player');
    assert.strictEqual(COMMAND_CLASSES['birthday:view'], 'general');
    assert.strictEqual(COMMAND_CLASSES['birthday:list'], 'server_moderate');
  });

  // ─── Command builder sanity ───
  await test('birthday command defines all three subcommands with bounds', async () => {
    const command = require('../bot/commands/birthday');
    const json = command.data.toJSON();
    assert.strictEqual(json.name, 'birthday');
    const names = json.options.map(o => o.name).sort();
    assert.deepStrictEqual(names, ['list', 'set', 'view']);
    const set = json.options.find(o => o.name === 'set');
    const month = set.options.find(o => o.name === 'month');
    assert.strictEqual(month.min_value, 1);
    assert.strictEqual(month.max_value, 12);
    const day = set.options.find(o => o.name === 'day');
    assert.strictEqual(day.max_value, 31);
    const visibility = set.options.find(o => o.name === 'visibility');
    assert.deepStrictEqual(visibility.choices.map(c => c.value).sort(), ['char_only', 'full', 'irl_date']);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
})();
