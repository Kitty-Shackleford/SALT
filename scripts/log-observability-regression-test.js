'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function testStreamingAdmDetails() {
  const parser = require('../routes/logParser');
  assert.equal(typeof parser.parseADMFileStream, 'function', 'streaming ADM parser must be executable in regressions');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dayz-adm-regression-'));
  const admPath = path.join(tempDir, 'DayZServerP_X1_x64_2026-08-27_12-29-34.ADM');
  const lines = [
    '15:01:00 | Player "Salt6199" (id=AAAAAAAA pos=<4485.4, 9763.8, 339.3>) performed EmoteDance',
    '15:01:00 | Player "Salt6199" (id=AAAAAAAA pos=<4485.4, 9763.8, 339.3>) performed EmoteDance',
    '15:02:00 | Player "Salt6199" (id=AAAAAAAA pos=<4450.8, 10549.1, 339.5>) placed Land Mine<LandMineTrap>',
    '15:03:00 | Player "Salt6199" (id=AAAAAAAA pos=<4450.3, 10550.3, 339.5>)[HP: 30.3754] hit by explosion (LandMineExplosion)',
    '15:22:42 | Player "Hector2462" (DEAD) (id=BBBBBBBB pos=<4909.8, 10512, 335.4>)[HP: 0] hit by Player "Porkey9884" (id=CCCCCCCC pos=<4927.5, 10504.6, 334.4>) into Torso(16) for 94.6837 damage (Bullet_556x45) with M4-A1 from 19.1778 meters',
    '15:22:42 | Player "Hector2462" (DEAD) (id=BBBBBBBB pos=<4909.8, 10512, 335.4>)[HP: 0] hit by Player "Porkey9884" (id=DDDDDDDD pos=<4909.8, 10512, 335.4>) into Head(1) for 1 damage (Bullet_22) with MKII from 1 meters',
    '15:22:42 | Player "Hector2462" (DEAD) (id=BBBBBBBB pos=<4909.8, 10512, 335.4>) killed by Player "Porkey9884" (id=CCCCCCCC pos=<4927.5, 10504.6, 334.4>) with M4-A1 from 19.1778 meters',
  ];
  fs.writeFileSync(admPath, lines.join('\n'));

  try {
    const parsed = await parser.parseADMFileStream(admPath, '2026-08-27');
    assert.equal(parsed.emoteEvents.length, 2);
    assert.equal(parsed.emoteEvents[0].emoteType, 'EmoteDance');
    assert.equal(parsed.emoteEvents[0].sourceFile, path.basename(admPath));
    assert.notEqual(parsed.emoteEvents[0].sourceLine, parsed.emoteEvents[1].sourceLine);
    assert.equal(parsed.territoryEvents.length, 1);
    assert.equal(parsed.territoryEvents[0].eventType, 'placed');
    assert.equal(parsed.territoryEvents[0].structureType, 'LandMineTrap');
    assert.equal(parsed.territoryEvents[0].sourceFile, path.basename(admPath));
    assert.equal(parsed.damageEvents.length, 3);
    assert.equal(parsed.damageEvents[0].sourceFile, path.basename(admPath));
    assert.deepStrictEqual(
      {
        type: parsed.damageEvents[0].attackerType,
        attacker: parsed.damageEvents[0].attackerGamertag,
        bodyPart: parsed.damageEvents[0].bodyPart,
        damage: parsed.damageEvents[0].damage,
        ammo: parsed.damageEvents[0].weapon,
        hpBefore: parsed.damageEvents[0].hpBefore,
        hpAfter: parsed.damageEvents[0].hpAfter,
      },
      { type: 'explosion', attacker: null, bodyPart: null, damage: null, ammo: 'LandMineExplosion', hpBefore: null, hpAfter: 30.3754 }
    );
    assert.deepStrictEqual(
      {
        type: parsed.damageEvents[1].attackerType,
        attacker: parsed.damageEvents[1].attackerGamertag,
        attackerId: parsed.damageEvents[1].attackerPlatformUserId,
        bodyPart: parsed.damageEvents[1].bodyPart,
        damage: parsed.damageEvents[1].damage,
        ammo: parsed.damageEvents[1].weapon,
        hpBefore: parsed.damageEvents[1].hpBefore,
        hpAfter: parsed.damageEvents[1].hpAfter,
      },
      { type: 'player', attacker: 'Porkey9884', attackerId: 'CCCCCCCC', bodyPart: 'Torso', damage: 94.6837, ammo: 'Bullet_556x45', hpBefore: 94.6837, hpAfter: 0 }
    );
    assert.equal(parsed.killEvents.length, 1);
    assert.equal(parsed.killEvents[0].weapon, 'M4-A1');
    assert.equal(parsed.killEvents[0].weaponExtra, 'Bullet_556x45');
    assert.equal(parsed.killEvents[0].bodyPart, 'Torso');
    assert.equal(parsed.killEvents[0].damage, 94.6837);

    assert.equal(typeof parser.parseCombatEvents, 'function');
    const nonStreaming = parser.parseCombatEvents(lines, '2026-08-27');
    assert.equal(nonStreaming.killEvents[0].weaponExtra, 'Bullet_556x45');
    assert.equal(nonStreaming.killEvents[0].bodyPart, 'Torso');
    assert.equal(nonStreaming.killEvents[0].damage, 94.6837);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function testKillFeedUsesPreKillSessionAndExactServerWallet() {
  const worker = require('../workers/feedProcessor');
  assert.equal(typeof worker.fetchVictimTimeAlive, 'function');
  assert.equal(typeof worker.fetchWalletBalance, 'function');

  const killTimestamp = '2026-08-27T15:22:42.000Z';
  const calls = [];
  const db = {
    async get(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (sql.includes('FROM player_sessions')) return { login_at: '2026-08-27T15:02:03.000Z' };
      if (sql.includes('FROM player_wallets')) return { cash_on_hand: '1510.10' };
      throw new Error('unexpected query');
    }
  };

  const aliveMs = await worker.fetchVictimTimeAlive(db, 601, 1, killTimestamp);
  assert.equal(aliveMs, 1239000);
  assert.match(calls[0].sql, /login_at <= \$3/);
  assert.deepStrictEqual(calls[0].params, [601, 1, killTimestamp]);

  const balance = await worker.fetchWalletBalance(db, 28, 1);
  assert.equal(balance, 1510.1);
  assert.match(calls[1].sql, /identity_id = \$1 AND server_id = \$2/);
  assert.deepStrictEqual(calls[1].params, [28, 1]);
}

function testKillFeedLabelsCapturedAmmunitionWithoutWeaponDuplication() {
  const { buildKillEmbedPayload } = require('../utils/feedMessageFormatter');
  const payload = buildKillEmbedPayload(
    { killer: 'Porkey9884', victim: 'Hector2462', weapon: 'M4-A1', weaponExtra: 'Bullet_556x45', distance: 19.1778, bodyPart: 'Torso', damage: 94.6837 },
    {},
    {},
    null,
    {},
    'Test Server'
  );
  const details = payload.embeds[0].fields.find(field => field.name === '• Details').value;
  assert.match(details, /\*\*Ammo:\*\* Bullet_556x45/);
  assert.doesNotMatch(details, /Weapon Extra/);
}

function testDamageAttackerResolutionIsExactServerScoped() {
  const source = fs.readFileSync(require.resolve('../routes/logParser'), 'utf8');
  const start = source.indexOf('async function saveDamageEvents');
  const end = source.indexOf('/**\n * Parse kill events', start);
  const saveDamage = source.slice(start, end);
  assert.match(saveDamage, /damageEvents\.flatMap\(event => \[/);
  assert.match(saveDamage, /event\.attackerType === 'player' \? event\.attackerPlatformUserId : null/);
  assert.match(saveDamage, /resolvedIdentityId\(identityMap, event\.attackerPlatformUserId, 'Damage attacker'\)/);
  assert.doesNotMatch(saveDamage, /pg\.gamertag = \?/);
}

function testCompletedSessionsUpdateWithoutDuplicatingRewards() {
  const source = fs.readFileSync(require.resolve('../routes/logParser'), 'utf8');
  const start = source.indexOf('async function saveSessions');
  const end = source.indexOf('// Save players to database', start);
  const saveSessions = source.slice(start, end);
  assert.match(saveSessions, /ON CONFLICT\(identity_id, server_id, login_at\) DO UPDATE SET/);
  assert.match(saveSessions, /WHERE player_sessions\.logout_at IS NULL AND EXCLUDED\.logout_at IS NOT NULL/);
  assert.match(saveSessions, /RETURNING id, \(xmax = 0\) AS inserted/);
  assert.match(saveSessions, /const wasNewSession = await db\.transaction\(/);
  assert.match(saveSessions, /inserted = sessionResult\?\.inserted === true/);
  assert.match(saveSessions, /awardMoneyInTransaction\(/);
  assert.match(saveSessions, /sessionCompletedNow = Boolean\(sessionResult && duration !== null && duration > 0\)/);
  assert.match(saveSessions, /if \(sessionCompletedNow\)/);
}

async function testObservabilityMigrationMakesRescansIdempotent() {
  const migration = require('../db/migrations/058_observability_event_uniqueness');
  const statements = [];
  await migration.up({
    async query(sql) {
      statements.push(sql.replace(/\s+/g, ' ').trim());
      return { rows: [], rowCount: 0 };
    }
  });
  const sql = statements.join('\n');
  for (const table of ['damage_events', 'territory_events', 'player_emote_events']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS source_file TEXT, ADD COLUMN IF NOT EXISTS source_line INTEGER`));
    assert.match(sql, new RegExp(`ON ${table} \\(server_id, source_file, source_line\\)`));
  }
  assert.match(sql, /DROP CONSTRAINT IF EXISTS territory_events_unique/);
  assert.match(sql, /pg_get_constraintdef\(c\.oid\) LIKE/);
  assert.match(sql, /ALTER TABLE damage_events DROP CONSTRAINT %I/);
  assert.equal((sql.match(/WHERE source_file IS NOT NULL AND source_line IS NOT NULL/g) || []).length, 3);
  assert.doesNotMatch(sql, /DELETE FROM/);
}

(async () => {
  await testStreamingAdmDetails();
  await testKillFeedUsesPreKillSessionAndExactServerWallet();
  testKillFeedLabelsCapturedAmmunitionWithoutWeaponDuplication();
  testDamageAttackerResolutionIsExactServerScoped();
  testCompletedSessionsUpdateWithoutDuplicatingRewards();
  await testObservabilityMigrationMakesRescansIdempotent();
  console.log('✅ Log observability regression tests passed');
})().catch(error => {
  console.error(error.stack || error.message);
  process.exit(1);
});
