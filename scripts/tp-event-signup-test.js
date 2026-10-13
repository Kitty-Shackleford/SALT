'use strict';

const { ensureTestEncryptionKey } = require('./lib/test-env');
ensureTestEncryptionKey();

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  createSignUpEvent,
  signUpForEvent,
  leaveEvent,
  closeEventAndQueueTeleports,
} = require('../services/teleportEventService');
const eventExpiry = require('../bot/utils/eventExpiry');
const { buildSignUpCard, parseSignUpCustomId } = require('../bot/utils/interactionButtons');

const authorizationSource = fs.readFileSync(path.join(__dirname, '..', 'bot', 'utils', 'commandAuthorization.js'), 'utf8');
assert.match(authorizationSource, /'tp-event':\s*'server_moderate'/);
assert.match(fs.readFileSync(path.join(__dirname, '..', 'bot', 'events', 'ready.js'), 'utf8'),
  /startEventExpiryMonitor/);

// ---- In-memory fake of the event + teleport tables ----
function makeDb(state) {
  return {
    async transaction(cb) { return cb(this); },
    async get(sql, params = []) {
      if (/pg_advisory_xact_lock/.test(sql)) return {};
      if (/COUNT\(\*\)/.test(sql)) {
        const c = state.signups.filter(s => s.event_id === Number(params[0])
          && s.status === 'joined').length;
        return { c };
      }
      if (/FROM event_teleport_signups/.test(sql) && /FOR UPDATE/.test(sql)) {
        return state.events.find(e => e.id === Number(params[0])) || null;
      }
      if (/FROM event_signups/.test(sql)) {
        return state.signups.find(s => s.event_id === Number(params[0])
          && s.identity_id === Number(params[1])) || null;
      }
      if (/COUNT\(\*\)/.test(sql)) {
        const c = state.signups.filter(s => s.event_id === Number(params[0])
          && s.status === 'joined').length;
        return { c };
      }
      if (/FROM servers/.test(sql)) return { id: 1, guild_id: 2 };
      if (/FROM guilds/.test(sql)) return { id: 2 };
      if (/FROM guild_roles/.test(sql)) return { role: 'owner' };
      if (/FROM server_role_assignments/.test(sql)) return null;
      if (/FROM server_player_memberships/.test(sql)) return { id: 4 };
      if (/FROM teleport_destinations/.test(sql)) {
        return { id: state.destinationId, server_id: 1, guild_id: 2, name: 'HQ',
          map_name: 'sakhal', destination_type: 'named', pos_x: 1, pos_y: 2, pos_z: 3,
          is_private: false, is_active: true };
      }
      if (/FROM player_pra_restrictions/.test(sql)) return state.restriction || null;
      if (/FROM teleport_requests/.test(sql)) return state.liveRequest || null;
      throw new Error(`Unexpected get: ${sql}`);
    },
    async query(sql, params = []) {
      if (/UPDATE event_teleport_signups/.test(sql)) {
        const e = state.events.find(x => x.id === Number(params[1]));
        if (e) e.status = params[0];
        return [e];
      }
      if (/UPDATE event_signups/.test(sql) && /status = 'left'/.test(sql)) {
        const s = state.signups.find(x => x.event_id === Number(params[0])
          && x.identity_id === Number(params[1]) && x.status === 'joined');
        if (s) s.status = 'left';
        return [s];
      }
      if (/UPDATE event_signups/.test(sql) && /status = 'joined'/.test(sql)) {
        const s = state.signups.find(x => x.event_id === Number(params[0])
          && x.identity_id === Number(params[1]));
        if (s) s.status = 'joined';
        return [s];
      }
      if (/SELECT identity_id FROM event_signups/.test(sql)) {
        return state.signups.filter(s => s.event_id === Number(params[0]) && s.status === 'joined')
          .map(s => ({ identity_id: s.identity_id }));
      }
      if (/INSERT INTO event_signups/.test(sql)) {
        const eventId = Number(params[0]);
        const identityId = Number(params[1]);
        const existing = state.signups.find(s => s.event_id === eventId && s.identity_id === identityId);
        if (existing) { existing.status = 'joined'; return [existing]; }
        const row = { id: state.nextSignupId++, event_id: eventId, identity_id: identityId, status: 'joined' };
        state.signups.push(row);
        return [row];
      }
      if (/INSERT INTO event_teleport_signups/.test(sql)) {
        // columns: guild_id, server_id, event_name, destination_id, channel_id,
        //   [status literal], cap, created_by_user_id, expires_at
        const row = {
          id: state.nextEventId++,
          guild_id: params[0], server_id: params[1], event_name: params[2],
          destination_id: params[3], channel_id: params[4], status: 'active',
          cap: params[5], created_by_user_id: params[6], expires_at: params[7],
        };
        state.events.push(row);
        return [row];
      }
      if (/INSERT INTO teleport_requests/.test(sql)) {
        const row = { id: state.nextRequestId++, status: 'waiting_disconnect' };
        state.requests.push(row);
        return [row];
      }
      if (/INSERT INTO teleport_events/.test(sql)) return [];
      throw new Error(`Unexpected query: ${sql} :: ${JSON.stringify(params)}`);
    },
  };
}

function freshState({ restriction = null, liveRequest = null } = {}) {
  return {
    events: [],
    signups: [],
    requests: [],
    restriction,
    liveRequest,
    nextEventId: 100,
    nextSignupId: 500,
    nextRequestId: 1000,
    destinationId: 7,
  };
}

(async () => {
  const state = freshState();
  const db = makeDb(state);
  const event = await createSignUpEvent(db, {
    guildId: 2, serverId: 1, destinationId: 7, durationMinutes: 30,
    cap: 25, eventName: 'Friday War', channelId: 'chan-1', actorUserId: 9,
  });
  assert.strictEqual(event.id, 100);
  assert.strictEqual(event.status, 'active');

  // Join.
  const joined = await signUpForEvent(db, {
    eventId: event.id, serverId: 1, guildId: 2, identityId: 11,
  });
  assert.strictEqual(joined.full, false);
  assert.deepStrictEqual(state.signups, [{
    id: 500, event_id: 100, identity_id: 11, status: 'joined',
  }]);

  // Duplicate join is rejected with a public message.
  await assert.rejects(signUpForEvent(db, {
    eventId: event.id, serverId: 1, guildId: 2, identityId: 11,
  }), error => error.code === 'ALREADY_JOINED' && /already signed up/i.test(error.publicMessage));

  // Leave, then re-join (upsert, no duplicate row).
  await leaveEvent(db, { eventId: event.id, serverId: 1, identityId: 11 });
  assert.strictEqual(state.signups[0].status, 'left');
  await signUpForEvent(db, { eventId: event.id, serverId: 1, guildId: 2, identityId: 11 });
  assert.strictEqual(state.signups.length, 1, 're-join must not create a second row');
  assert.strictEqual(state.signups[0].status, 'joined');

  // Cap enforcement: cap 1, second distinct player -> EVENT_FULL.
  const state2 = freshState();
  const db2 = makeDb(state2);
  const small = await createSignUpEvent(db2, {
    guildId: 2, serverId: 1, destinationId: 7, durationMinutes: 5,
    cap: 1, eventName: 'Duels', channelId: 'chan-1', actorUserId: 9,
  });
  await signUpForEvent(db2, { eventId: small.id, serverId: 1, guildId: 2, identityId: 21 });
  await assert.rejects(signUpForEvent(db2, {
    eventId: small.id, serverId: 1, guildId: 2, identityId: 22,
  }), error => error.code === 'EVENT_FULL' && /full/i.test(error.publicMessage));

  // Close: queues every joined identity via the standard moderator path.
  const state3 = freshState();
  const db3 = makeDb(state3);
  const ev3 = await createSignUpEvent(db3, {
    guildId: 2, serverId: 1, destinationId: 7, durationMinutes: 5,
    cap: 5, eventName: 'Evac', channelId: 'chan-1', actorUserId: 9,
  });
  await signUpForEvent(db3, { eventId: ev3.id, serverId: 1, guildId: 2, identityId: 31 });
  await signUpForEvent(db3, { eventId: ev3.id, serverId: 1, guildId: 2, identityId: 32 });
  await signUpForEvent(db3, { eventId: ev3.id, serverId: 1, guildId: 2, identityId: 33 });
  const summary = await closeEventAndQueueTeleports(db3, {
    serverId: 1, guildId: 2, eventId: ev3.id, actorUserId: 9, finalStatus: 'closed',
  });
  assert.strictEqual(summary.queued.length, 3, 'every joined identity must be queued');
  assert.strictEqual(summary.failed.length, 0);
  assert.strictEqual(state3.events[0].status, 'closed');
  assert.strictEqual(state3.requests.length, 3);

  // Close again -> already closed, no-op.
  await assert.rejects(closeEventAndQueueTeleports(db3, {
    serverId: 1, guildId: 2, eventId: ev3.id, actorUserId: 9, finalStatus: 'closed',
  }), error => error.code === 'EVENT_CLOSED');

  // Close skips PRA-restricted / already-pending identities but still closes.
  // The restriction points at a destination other than the event destination,
  // so the standard moderator path rejects the teleport.
  const state4 = freshState({
    restriction: { id: 99, destination_id: 99, status: 'active' },
  });
  const db4 = makeDb(state4);
  const ev4 = await createSignUpEvent(db4, {
    guildId: 2, serverId: 1, destinationId: 7, durationMinutes: 5,
    cap: 5, eventName: 'Mixed', channelId: 'chan-1', actorUserId: 9,
  });
  await signUpForEvent(db4, { eventId: ev4.id, serverId: 1, guildId: 2, identityId: 41 });
  const summary4 = await closeEventAndQueueTeleports(db4, {
    serverId: 1, guildId: 2, eventId: ev4.id, actorUserId: 9, finalStatus: 'closed',
  });
  assert.strictEqual(summary4.queued.length, 0);
  assert.strictEqual(summary4.failed.length, 1, 'PRA-restricted identity must be reported as failed');
  assert.strictEqual(state4.events[0].status, 'closed', 'event still closes when all fail');

  // ---- Expiry monitor: processExpiredEvents closes expired + queues ----
  const state5 = freshState();
  const db5 = makeDb(state5);
  const ev5 = await createSignUpEvent(db5, {
    guildId: 2, serverId: 1, destinationId: 7, durationMinutes: 60,
    cap: 5, eventName: 'Timed', channelId: 'chan-1', actorUserId: 9,
  });
  await signUpForEvent(db5, { eventId: ev5.id, serverId: 1, guildId: 2, identityId: 51 });
  // Mark the event expired.
  state5.events[0].expires_at = new Date(Date.now() - 1000);
  // Expiry monitor's SELECT picks up events past expires_at.
  const expiryDb = {
    async transaction(cb) { return cb(this); },
    async query(sql) {
      if (/FROM event_teleport_signups/.test(sql) && /expires_at <= NOW\(\)/.test(sql)) {
        return state5.events.filter(e => new Date(e.expires_at).getTime() <= Date.now())
          .map(e => ({
            id: e.id, guild_id: e.guild_id, server_id: e.server_id,
            event_name: e.event_name, created_by_user_id: e.created_by_user_id, status: e.status,
          }));
      }
      throw new Error(`Unexpected expiry query: ${sql}`);
    },
    // Delegate everything else to the stateful db.
    get: (sql, p) => db5.get(sql, p),
    query2: undefined,
  };
  // The monitor uses db_.transaction(cb) then closeEventAndQueueTeleports(cb db).
  const monitorDb = Object.assign({ async transaction(cb) { return cb(this); } }, db5);
  // The monitor's initial SELECT must see the expired event; route it to the
  // same rows the stateful db would serve.
  const origQuery = monitorDb.query.bind(monitorDb);
  monitorDb.query = async (sql, params) => {
    if (/FROM event_teleport_signups/.test(sql) && /expires_at <= NOW\(\)/.test(sql)) {
      return state5.events.filter(e => new Date(e.expires_at).getTime() <= Date.now())
        .map(e => ({
          id: e.id, guild_id: e.guild_id, server_id: e.server_id,
          event_name: e.event_name, created_by_user_id: e.created_by_user_id, status: e.status,
        }));
    }
    return origQuery(sql, params);
  };
  const expiryResult = await eventExpiry.processExpiredEvents(monitorDb);
  assert.strictEqual(expiryResult.expired, 1);
  assert.strictEqual(state5.events[0].status, 'expired', 'expired event must be marked expired');
  assert.strictEqual(state5.requests.length, 1, 'the joined identity must be queued on expiry');
  assert.strictEqual(expiryResult.results[0].queued.length, 1);

  // An unexpired event must NOT be touched.
  const state6 = freshState();
  const db6 = makeDb(state6);
  await createSignUpEvent(db6, {
    guildId: 2, serverId: 1, destinationId: 7, durationMinutes: 60,
    cap: 5, eventName: 'Live', channelId: 'chan-1', actorUserId: 9,
  });
  const monitorDb6 = Object.assign({ async transaction(cb) { return cb(this); } }, db6);
  const origQuery6 = monitorDb6.query.bind(monitorDb6);
  monitorDb6.query = async (sql, params) => {
    if (/FROM event_teleport_signups/.test(sql) && /expires_at <= NOW\(\)/.test(sql)) {
      return state6.events.filter(e => new Date(e.expires_at).getTime() <= Date.now())
        .map(e => ({ id: e.id, guild_id: e.guild_id, server_id: e.server_id, event_name: e.event_name,
          created_by_user_id: e.created_by_user_id, status: e.status }));
    }
    return origQuery6(sql, params);
  };
  const none = await eventExpiry.processExpiredEvents(monitorDb6);
  assert.strictEqual(none.expired, 0, 'a live event must not be processed');
  assert.strictEqual(state6.requests.length, 0);

  // ---- Button card helpers ----
  assert.deepStrictEqual(parseSignUpCustomId('sign_up:100:join'), { eventId: 100, action: 'join' });
  assert.deepStrictEqual(parseSignUpCustomId('sign_up:100:leave'), { eventId: 100, action: 'leave' });
  assert.strictEqual(parseSignUpCustomId('sign_up:100:hack'), null);
  assert.strictEqual(parseSignUpCustomId('other:100:join'), null);
  const card = buildSignUpCard({ id: 100, event_name: 'Friday War', cap: 25, status: 'active',
    expires_at: new Date(Date.now() + 60000) }, 3);
  assert(Array.isArray(card.embeds) && card.embeds.length === 1);
  assert(Array.isArray(card.components) && card.components.length === 1);
  // The row serializes to two buttons with the sign_up customId convention.
  const serializedRow = card.components[0].toJSON();
  assert.deepStrictEqual(
    serializedRow.components.map(c => c.custom_id),
    ['sign_up:100:join', 'sign_up:100:leave'],
    'Join and Leave buttons must use the sign_up:<eventId>:<action> customId');

  console.log('✅ tp-event sign-up tests passed');
})().catch(error => {
  console.error(error);
  process.exit(1);
});
