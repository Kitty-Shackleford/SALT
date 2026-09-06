'use strict';

const assert = require('assert');

const SERVICE_ID = 'service-42';
const TOKEN = 'test-token';
const MISSION = 'dayzOffline.chernarusplus';
const MISSION_ROOT = '/games/account/ftproot/dayzstandalone/mpmissions';
const INIT_PATH = `${MISSION_ROOT}/${MISSION}/init.c`;

function listResponse(entries) {
  return { data: { status: 'success', data: { entries } } };
}

async function testReadablePcInitIsSupported() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const source = 'void main() {}\n';
  const calls = [];
  const service = createMissionInitCapabilityService({
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh(token, serviceId) {
        assert.strictEqual(token, TOKEN);
        assert.strictEqual(serviceId, SERVICE_ID);
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url, options = {}) {
        calls.push([url, options]);
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) {
          assert(url.endsWith(encodeURIComponent(`${MISSION_ROOT}/${MISSION}`)));
          return listResponse([
            { name: 'init.c', type: 'file', path: INIT_PATH, size: Buffer.byteLength(source) },
          ]);
        }
        if (url.includes('/file_server/download?file=')) {
          assert(url.endsWith(encodeURIComponent(INIT_PATH)));
          assert.strictEqual(options.maxContentLength, 512 * 1024);
          assert.strictEqual(options.maxBodyLength, 512 * 1024);
          return { data: { status: 'success', data: { token: { url: 'https://download.example/init' } } } };
        }
        if (url === 'https://download.example/init') {
          assert.strictEqual(options.responseType, 'arraybuffer');
          assert.strictEqual(options.maxRedirects, 0);
          assert.strictEqual(options.proxy, false);
          assert.strictEqual(typeof options.lookup, 'function');
          assert.strictEqual(options.headers?.Authorization, undefined);
          return { data: Buffer.from(source) };
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    },
  });

  const result = await service.probe({
    platformServerId: SERVICE_ID,
    token: TOKEN,
    includeContent: true,
  });

  assert.deepStrictEqual(result, {
    capability: 'mission.init_c',
    status: 'supported',
    reasonCode: 'init_c_readable',
    platform: 'pc',
    activeMission: MISSION,
    observedAt: '2026-09-05T01:00:00.000Z',
    readable: true,
    writable: false,
    runtimeVerified: false,
    supportLevel: 'readable',
    rolloutEnabled: true,
    size: Buffer.byteLength(source),
    hash: require('crypto').createHash('sha256').update(source).digest('hex'),
    content: source,
  });
  assert(calls.every(([, options]) => options.headers?.Authorization !== undefined || options.responseType === 'arraybuffer'));
}

async function testMissingInitIsAbsentWithoutDownloading() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const calls = [];
  const service = createMissionInitCapabilityService({
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url) {
        calls.push(url);
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) return listResponse([]);
        throw new Error('Absent init.c must not trigger a download');
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });
  assert.deepStrictEqual(result, {
    capability: 'mission.init_c',
    status: 'absent',
    reasonCode: 'init_c_absent',
    platform: 'pc',
    activeMission: MISSION,
    observedAt: '2026-09-05T01:00:00.000Z',
    readable: false,
    writable: false,
    runtimeVerified: false,
    supportLevel: 'unsupported',
    rolloutEnabled: false,
  });
  assert.strictEqual(calls.some(url => url.includes('/file_server/download')), false);
}

async function testProviderFailureIsUnknownNotAbsent() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const providerError = new Error('upstream unavailable');
  providerError.code = 'NITRADO_TIMEOUT';
  const service = createMissionInitCapabilityService({
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh() { throw providerError; },
    },
    http: { async get() { throw new Error('HTTP must not be reached'); } },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });
  assert.deepStrictEqual(result, {
    capability: 'mission.init_c',
    status: 'unknown',
    reasonCode: 'provider_timeout',
    platform: 'unknown',
    activeMission: null,
    observedAt: '2026-09-05T01:00:00.000Z',
    readable: false,
    writable: false,
    runtimeVerified: false,
    supportLevel: 'unknown',
    rolloutEnabled: false,
  });
}

async function testAccessUsesCanonicalInternalServerContext() {
  const { createMissionInitAccessService } = require('../services/missionInitCapabilityService');
  const calls = [];
  const accessService = createMissionInitAccessService({
    authorizeServer: async (_db, actor, serverId, capability) => {
      calls.push(['authorize', actor.id, serverId, capability]);
      return {
        guild: { id: 9 },
        server: { id: 42, platformServerId: SERVICE_ID },
      };
    },
    decryptToken: value => {
      calls.push(['decrypt', value]);
      return TOKEN;
    },
    capabilityService: {
      async probe(input) {
        calls.push(['probe', input]);
        return { capability: 'mission.init_c', status: 'supported' };
      },
    },
  });
  const db = {
    async get(sql, params) {
      calls.push(['get', sql, params]);
      return { platform_server_id: SERVICE_ID, token_hash: 'encrypted' };
    },
  };

  const result = await accessService.probeForActor({
    db,
    actor: { id: 7 },
    internalServerId: '42',
    includeContent: true,
  });

  assert.deepStrictEqual(result, { capability: 'mission.init_c', status: 'supported' });
  assert.deepStrictEqual(calls[0], ['authorize', 7, 42, 'server.manage']);
  assert.deepStrictEqual(calls[1][2], [42, 9]);
  assert.match(calls[1][1], /s\.id = \?/);
  assert.match(calls[1][1], /s\.guild_id = \?/);
  assert.deepStrictEqual(calls.at(-1), ['probe', {
    platformServerId: SERVICE_ID,
    token: TOKEN,
    includeContent: true,
  }]);
}

async function testObservedConsoleInitRemainsOutsidePcRollout() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const consoleMissionRoot = '/games/account/ftproot/dayzxb_missions';
  const consoleInitPath = `${consoleMissionRoot}/${MISSION}/init.c`;
  const source = 'void main() {}\n';
  const service = createMissionInitCapabilityService({
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzxb',
          game_specific: { path: '/games/account/noftp/dayzxb' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url) {
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzxb', type: 'dir', path: '/games/account/noftp/dayzxb' },
            { name: 'dayzxb_missions', type: 'dir', path: consoleMissionRoot },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) {
          return listResponse([
            { name: 'init.c', type: 'file', path: consoleInitPath, size: Buffer.byteLength(source) },
          ]);
        }
        if (url.includes('/file_server/download?file=')) {
          return { data: { status: 'success', data: { token: { url: 'https://download.example/console-init' } } } };
        }
        if (url === 'https://download.example/console-init') return { data: Buffer.from(source) };
        throw new Error(`Unexpected URL: ${url}`);
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });
  assert.strictEqual(result.status, 'supported');
  assert.strictEqual(result.platform, 'xbox');
  assert.strictEqual(result.readable, true);
  assert.strictEqual(result.rolloutEnabled, false);
}

async function testDeniedAccessStopsBeforeCredentialOrProviderCalls() {
  const { createMissionInitAccessService } = require('../services/missionInitCapabilityService');
  let dbTouched = false;
  let providerTouched = false;
  const accessService = createMissionInitAccessService({
    authorizeServer: async () => null,
    decryptToken: () => { throw new Error('decrypt must not run'); },
    capabilityService: {
      async probe() { providerTouched = true; },
    },
  });
  const db = {
    async get() { dbTouched = true; },
  };

  await assert.rejects(
    () => accessService.probeForActor({
      db,
      actor: { id: 7 },
      internalServerId: '42',
    }),
    error => error.status === 404 && error.code === 'SERVER_NOT_FOUND'
  );
  assert.strictEqual(dbTouched, false);
  assert.strictEqual(providerTouched, false);
}

function routeHandler(router, routePath, method = 'get') {
  const layer = router.stack.find(candidate =>
    candidate.route?.path === routePath && candidate.route.methods?.[method]
  );
  assert(layer, `Missing ${method.toUpperCase()} ${routePath}`);
  return layer.route.stack.at(-1).handle;
}

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function testCapabilityRouteUsesInternalServerIdWithoutContent() {
  const { createMissionInitRouter } = require('../routes/missionInit');
  const calls = [];
  const router = createMissionInitRouter({
    ensureAuthenticated: (_req, _res, next) => next(),
    accessService: {
      async probeForActor(input) {
        calls.push(input);
        return {
          capability: 'mission.init_c',
          status: 'supported',
          platform: 'pc',
          rolloutEnabled: true,
          content: 'must not leak',
        };
      },
    },
  });
  const handler = routeHandler(router, '/servers/:serverId/capabilities/mission-init');
  const db = { marker: true };
  const req = { params: { serverId: '42' }, user: { id: 7 }, app: { locals: { db } } };
  const res = responseRecorder();

  await handler(req, res);

  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(res.body.success, true);
  assert.strictEqual(Object.hasOwn(res.body.capability, 'content'), false);
  assert.deepStrictEqual(calls, [{
    db,
    actor: req.user,
    internalServerId: '42',
    includeContent: false,
  }]);
}

async function testPreviewRouteReturnsProviderContentForSupportedPc() {
  const { createMissionInitRouter } = require('../routes/missionInit');
  const source = 'void main() {}\n';
  const router = createMissionInitRouter({
    ensureAuthenticated: (_req, _res, next) => next(),
    accessService: {
      async probeForActor(input) {
        assert.strictEqual(input.includeContent, true);
        return {
          capability: 'mission.init_c',
          status: 'supported',
          reasonCode: 'init_c_readable',
          platform: 'pc',
          rolloutEnabled: true,
          content: source,
          hash: 'abc',
        };
      },
    },
  });
  const handler = routeHandler(router, '/servers/:serverId/mission-init');
  const res = responseRecorder();

  await handler({
    params: { serverId: '42' },
    user: { id: 7 },
    app: { locals: { db: {} } },
  }, res);

  assert.strictEqual(res.statusCode, 200);
  assert.deepStrictEqual(res.body, {
    success: true,
    capability: {
      capability: 'mission.init_c',
      status: 'supported',
      reasonCode: 'init_c_readable',
      platform: 'pc',
      rolloutEnabled: true,
      hash: 'abc',
    },
    content: source,
  });
}

async function testPreviewRouteReportsUnknownAsUpstreamFailure() {
  const { createMissionInitRouter } = require('../routes/missionInit');
  const router = createMissionInitRouter({
    ensureAuthenticated: (_req, _res, next) => next(),
    accessService: {
      async probeForActor() {
        return {
          capability: 'mission.init_c',
          status: 'unknown',
          reasonCode: 'provider_timeout',
          platform: 'pc',
          rolloutEnabled: false,
        };
      },
    },
  });
  const handler = routeHandler(router, '/servers/:serverId/mission-init');
  const res = responseRecorder();
  await handler({
    params: { serverId: '42' },
    user: { id: 7 },
    app: { locals: { db: {} } },
  }, res);

  assert.strictEqual(res.statusCode, 502);
  assert.strictEqual(res.body.code, 'provider_timeout');
  assert.strictEqual(Object.hasOwn(res.body, 'content'), false);
}

async function testFreshGameserverLookupBypassesMetadataCache() {
  const { createNitradoService } = require('../services/nitradoService');
  let calls = 0;
  const service = createNitradoService({
    cacheTtlMs: 60000,
    request: async () => {
      calls += 1;
      return {
        data: {
          status: 'success',
          data: {
            gameserver: {
              service_id: '42',
              game: 'dayzstandalone',
              settings: { config: { mission: calls === 1 ? 'mission.old' : 'mission.new' } },
            },
          },
        },
      };
    },
  });

  const cached = await service.getRawGameserver(TOKEN, '42');
  const fresh = await service.getRawGameserverFresh(TOKEN, '42');
  const cachedAgain = await service.getRawGameserver(TOKEN, '42');

  assert.strictEqual(cached.settings.config.mission, 'mission.old');
  assert.strictEqual(fresh.settings.config.mission, 'mission.new');
  assert.strictEqual(cachedAgain.settings.config.mission, 'mission.old');
  assert.strictEqual(calls, 2);
}

async function testCapabilityProbeUsesFreshGameserverLookup() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  let cachedCalled = false;
  let freshCalled = false;
  const service = createMissionInitCapabilityService({
    nitradoService: {
      async getRawGameserver() {
        cachedCalled = true;
        throw new Error('Cached metadata must not be used');
      },
      async getRawGameserverFresh() {
        freshCalled = true;
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url) {
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) return listResponse([]);
        throw new Error(`Unexpected request: ${url}`);
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });

  assert.strictEqual(result.status, 'absent');
  assert.strictEqual(freshCalled, true);
  assert.strictEqual(cachedCalled, false);
}

async function testUnsafeTransferUrlsAreRejectedBeforeDownload() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  for (const transferUrl of [
    'https://127.0.0.1/private',
    'https://[::1]/private',
    'https://user@download.example/private',
  ]) {
    let unsafeUrlFetched = false;
    const service = createMissionInitCapabilityService({
      nitradoService: {
        async getRawGameserverFresh() {
          return {
            game: 'dayzstandalone',
            game_specific: { path: '/games/account/ftproot/dayzstandalone' },
            settings: { config: { mission: MISSION } },
          };
        },
      },
      http: {
        async get(url) {
          if (url.endsWith('/file_server/list')) {
            return listResponse([
              { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
            ]);
          }
          if (url.includes('/file_server/list?dir=')) {
            return listResponse([
              { name: 'init.c', type: 'file', path: INIT_PATH, size: 1 },
            ]);
          }
          if (url.includes('/file_server/download?file=')) {
            return { data: { status: 'success', data: { token: { url: transferUrl } } } };
          }
          if (url === transferUrl) unsafeUrlFetched = true;
          throw new Error(`Unexpected request: ${url}`);
        },
      },
    });

    const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });

    assert.strictEqual(result.status, 'unknown');
    assert.strictEqual(result.reasonCode, 'provider_invalid_response');
    assert.strictEqual(unsafeUrlFetched, false);
  }
}

async function testPrivateDnsResolutionIsRejectedBeforeTransferCompletes() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const { createPublicAddressLookup } = require('../utils/publicAddressLookup');
  let lookupCalled = false;
  let transferCompleted = false;
  const publicAddressLookup = createPublicAddressLookup((hostname, options, callback) => {
    lookupCalled = true;
    callback(null, [{ address: '127.0.0.1', family: 4 }]);
  });
  const transferUrl = 'https://download.example/init';
  const service = createMissionInitCapabilityService({
    publicAddressLookup,
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url, options = {}) {
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) {
          return listResponse([{ name: 'init.c', type: 'file', path: INIT_PATH, size: 1 }]);
        }
        if (url.includes('/file_server/download?file=')) {
          return { data: { status: 'success', data: { token: { url: transferUrl } } } };
        }
        if (url === transferUrl) {
          await new Promise((resolve, reject) => options.lookup(
            'download.example',
            {},
            error => error ? reject(error) : resolve()
          ));
          transferCompleted = true;
          return { data: Buffer.from('x') };
        }
        throw new Error(`Unexpected request: ${url}`);
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });

  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(lookupCalled, true);
  assert.strictEqual(transferCompleted, false);
}

async function testProviderListingsUseExplicitResponseBounds() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  let listingCalls = 0;
  const service = createMissionInitCapabilityService({
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url, options = {}) {
        if (!url.includes('/file_server/list')) {
          throw new Error(`Unexpected request: ${url}`);
        }
        listingCalls += 1;
        assert.strictEqual(options.maxContentLength, 512 * 1024);
        assert.strictEqual(options.maxBodyLength, 512 * 1024);
        if (!url.includes('?dir=')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        return listResponse([]);
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });

  assert.strictEqual(result.status, 'absent');
  assert.strictEqual(listingCalls, 2);
}

async function testOversizedInitHasStableReasonAndIsNotDownloaded() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const calls = [];
  const service = createMissionInitCapabilityService({
    maxBytes: 16,
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url) {
        calls.push(url);
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) {
          return listResponse([
            { name: 'init.c', type: 'file', path: INIT_PATH, size: 17 },
          ]);
        }
        throw new Error('Oversized init.c must not be downloaded');
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });
  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.reasonCode, 'init_c_too_large');
  assert.strictEqual(calls.some(url => url.includes('/file_server/download')), false);
}

async function testIncompleteInitIsUnknownInvalidResponse() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const advertised = 'void main() { complete(); }\n';
  const partial = Buffer.from('void main() {}\n');
  const service = createMissionInitCapabilityService({
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url) {
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) {
          return listResponse([
            { name: 'init.c', type: 'file', path: INIT_PATH, size: Buffer.byteLength(advertised) },
          ]);
        }
        if (url.includes('/file_server/download?file=')) {
          return { data: { status: 'success', data: { token: { url: 'https://download.example/init' } } } };
        }
        if (url === 'https://download.example/init') return { data: partial };
        throw new Error(`Unexpected URL: ${url}`);
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });
  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.reasonCode, 'provider_invalid_response');
  assert.strictEqual(result.readable, false);
}

async function testNonScalarAdvertisedSizeIsUnknownInvalidResponse() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const source = Buffer.from('x');
  const service = createMissionInitCapabilityService({
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url) {
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) {
          return listResponse([
            { name: 'init.c', type: 'file', path: INIT_PATH, size: [source.length] },
          ]);
        }
        if (url.includes('/file_server/download?file=')) {
          return { data: { status: 'success', data: { token: { url: 'https://download.example/init' } } } };
        }
        if (url === 'https://download.example/init') return { data: source };
        throw new Error(`Unexpected URL: ${url}`);
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });
  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.reasonCode, 'provider_invalid_response');
  assert.strictEqual(result.readable, false);
}

async function testNegativeZeroAdvertisedSizeIsUnknownInvalidResponse() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const service = createMissionInitCapabilityService({
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url) {
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) {
          return listResponse([
            { name: 'init.c', type: 'file', path: INIT_PATH, size: -0 },
          ]);
        }
        throw new Error('Negative-zero size must be rejected before download');
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });
  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.reasonCode, 'provider_invalid_response');
  assert.strictEqual(result.readable, false);
}

function testRejectsInvalidCapabilityLimits() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  for (const value of [0, -1, 1.5, '16', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => createMissionInitCapabilityService({ maxBytes: value }),
      /maxBytes must be a positive safe integer/
    );
    assert.throws(
      () => createMissionInitCapabilityService({ maxListingBytes: value }),
      /maxListingBytes must be a positive safe integer/
    );
  }
}

async function testMalformedUtf8IsUnknownInvalidResponse() {
  const { createMissionInitCapabilityService } = require('../services/missionInitCapabilityService');
  const invalid = Buffer.from([0xc3, 0x28]);
  const service = createMissionInitCapabilityService({
    now: () => new Date('2026-09-05T01:00:00.000Z'),
    nitradoService: {
      async getRawGameserverFresh() {
        return {
          game: 'dayzstandalone',
          game_specific: { path: '/games/account/ftproot/dayzstandalone' },
          settings: { config: { mission: MISSION } },
        };
      },
    },
    http: {
      async get(url) {
        if (url.endsWith('/file_server/list')) {
          return listResponse([
            { name: 'dayzstandalone', type: 'dir', path: '/games/account/ftproot/dayzstandalone' },
          ]);
        }
        if (url.includes('/file_server/list?dir=')) {
          return listResponse([
            { name: 'init.c', type: 'file', path: INIT_PATH, size: invalid.length },
          ]);
        }
        if (url.includes('/file_server/download?file=')) {
          return { data: { status: 'success', data: { token: { url: 'https://download.example/init' } } } };
        }
        if (url === 'https://download.example/init') return { data: invalid };
        throw new Error(`Unexpected URL: ${url}`);
      },
    },
  });

  const result = await service.probe({ platformServerId: SERVICE_ID, token: TOKEN });
  assert.strictEqual(result.status, 'unknown');
  assert.strictEqual(result.reasonCode, 'provider_invalid_response');
}

async function testDeploymentContextReauthorizesAndReturnsAuthoritativeProviderPath() {
  const { createMissionInitAccessService } = require('../services/missionInitCapabilityService');
  const calls = [];
  const accessService = createMissionInitAccessService({
    authorizeServer: async (_db, actor, serverId, capability) => {
      calls.push(['authorize', actor.id, serverId, capability]);
      return {
        guild: { id: 9 },
        server: { id: 42, platformServerId: SERVICE_ID },
      };
    },
    decryptToken: () => TOKEN,
    capabilityService: {
      async probe(input) {
        calls.push(['probe', input]);
        return {
          status: 'supported',
          rolloutEnabled: true,
          platform: 'pc',
          content: 'source',
          hash: 'a'.repeat(64),
          providerPath: INIT_PATH,
        };
      },
    },
  });
  const db = {
    async get(sql, params) {
      calls.push(['get', sql, params]);
      return { platform_server_id: SERVICE_ID, token_hash: 'encrypted' };
    },
  };

  const result = await accessService.resolveDeploymentContext({
    db,
    actor: { id: 7 },
    internalServerId: 42,
  });

  assert.strictEqual(result.filePath, INIT_PATH);
  assert.strictEqual(result.platformServerId, SERVICE_ID);
  assert.strictEqual(result.token, TOKEN);
  assert.match(calls[1][1], /FOR NO KEY UPDATE/);
  assert.deepStrictEqual(calls.at(-1), ['probe', {
    platformServerId: SERVICE_ID,
    token: TOKEN,
    includeContent: true,
    includeProviderPath: true,
  }]);
}

function testMissionInitRouterIsMounted() {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'app', 'registerRoutes.js'),
    'utf8'
  );
  assert.match(source, /const missionInitRoutes = require\('\.\.\/\.\.\/routes\/missionInit'\)/);
  assert.match(source, /app\.use\('\/api', missionInitRoutes\)/);
}

async function main() {
  await testReadablePcInitIsSupported();
  await testMissingInitIsAbsentWithoutDownloading();
  await testProviderFailureIsUnknownNotAbsent();
  await testAccessUsesCanonicalInternalServerContext();
  await testObservedConsoleInitRemainsOutsidePcRollout();
  await testDeniedAccessStopsBeforeCredentialOrProviderCalls();
  await testCapabilityRouteUsesInternalServerIdWithoutContent();
  await testPreviewRouteReturnsProviderContentForSupportedPc();
  await testPreviewRouteReportsUnknownAsUpstreamFailure();
  await testFreshGameserverLookupBypassesMetadataCache();
  await testCapabilityProbeUsesFreshGameserverLookup();
  await testUnsafeTransferUrlsAreRejectedBeforeDownload();
  await testPrivateDnsResolutionIsRejectedBeforeTransferCompletes();
  await testProviderListingsUseExplicitResponseBounds();
  await testOversizedInitHasStableReasonAndIsNotDownloaded();
  await testIncompleteInitIsUnknownInvalidResponse();
  await testNonScalarAdvertisedSizeIsUnknownInvalidResponse();
  await testNegativeZeroAdvertisedSizeIsUnknownInvalidResponse();
  testRejectsInvalidCapabilityLimits();
  await testMalformedUtf8IsUnknownInvalidResponse();
  await testDeploymentContextReauthorizesAndReturnsAuthoritativeProviderPath();
  testMissionInitRouterIsMounted();
  console.log('mission init capability tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
