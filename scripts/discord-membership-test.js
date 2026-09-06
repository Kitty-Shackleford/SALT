'use strict';

const assert = require('assert');
const { verifyDiscordGuildMembership } = require('../services/discordGuildMembershipService');

async function main() {
  const originalFetch = global.fetch;
  const originalToken = process.env.DISCORD_BOT_TOKEN;
  process.env.DISCORD_BOT_TOKEN = 'test-token-not-a-real-secret';
  try {
    global.fetch = async (url, options) => {
      assert.equal(url, 'https://discord.com/api/v10/guilds/900000000000000001/members/900000000000000002');
      assert.equal(options.headers.Authorization, 'Bot test-token-not-a-real-secret');
      return {
        ok: true,
        status: 200,
        async json() { return { user: { id: '900000000000000002' } }; },
      };
    };
    assert.equal(await verifyDiscordGuildMembership(
      '900000000000000001', '900000000000000002'
    ), true, 'matching authoritative Discord member should be eligible');

    global.fetch = async () => ({ ok: false, status: 404, async json() { return {}; } });
    assert.equal(await verifyDiscordGuildMembership(
      '900000000000000001', '900000000000000002'
    ), false, 'Discord 404 must deny membership');

    global.fetch = async () => ({ ok: false, status: 403, async json() { return {}; } });
    await assert.rejects(
      verifyDiscordGuildMembership('900000000000000001', '900000000000000002'),
      error => error.code === 'DISCORD_MEMBERSHIP_UNAVAILABLE',
      'Discord permission failures must fail closed as unavailable'
    );

    await assert.rejects(
      verifyDiscordGuildMembership('not-a-snowflake', '900000000000000002'),
      error => error.code === 'INVALID_DISCORD_ID',
      'invalid guild IDs must be rejected before any request'
    );
    console.log('✅ Discord guild membership verification tests passed');
  } finally {
    global.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.DISCORD_BOT_TOKEN;
    else process.env.DISCORD_BOT_TOKEN = originalToken;
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
