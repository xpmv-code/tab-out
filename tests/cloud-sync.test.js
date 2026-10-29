const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const modulePath = path.resolve(__dirname, '../extension/services/cloudSync.js');
const source = readFileSync(modulePath, 'utf8');

function loadSync(config = {}, options = {}) {
  let fetchCount = 0;
  const stored = { ...(options.initialStorage || {}) };
  const alarmCalls = [];
  const context = {
    TAB_OUT_SYNC_CONFIG: config,
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: stored[keys] };
            if (Array.isArray(keys)) return Object.fromEntries(keys.filter(key => key in stored).map(key => [key, stored[key]]));
            return { ...stored };
          },
          async set(values) { Object.assign(stored, values); },
          async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(key => delete stored[key]); },
        },
      },
      permissions: {
        async contains() { return options.permissionGranted !== false; },
        async request() { return options.permissionGranted !== false; },
      },
      alarms: {
        create(name, info) { alarmCalls.push({ name, info }); },
        async clear() { return true; },
      },
    },
    fetch: async (...args) => {
      fetchCount += 1;
      if (options.fetch) return options.fetch(...args);
      throw new Error('unexpected fetch');
    },
    URL,
    Date,
    Math,
    atob: typeof atob === 'function' ? atob : undefined,
    document: options.worker ? undefined : {
      visibilityState: 'visible',
      getElementById() { return null; },
      addEventListener() {},
    },
    CustomEvent: class CustomEvent {
      constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
    },
    dispatchEvent() {},
    console: { warn() {}, info() {} },
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: modulePath });
  return {
    api: context.TabOutCloudSync,
    stored,
    fetchCount: () => fetchCount,
    alarmCalls,
  };
}

function group(id, name, updatedAt, order = 0) {
  return { id, name, createdAt: '2026-01-01T00:00:00.000Z', updatedAt, order };
}

function link(id, url, groupId, title, updatedAt, order = 0) {
  return {
    id, url, groupId, title, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt, order, description: '', favicon: '', category: '', badge: '',
    color: '', metadataSource: '', suggestedCategory: '', suggestionStatus: '',
    suggestionCheckedAt: '',
  };
}

test('buildLocalDocument round-trips group/link data without leaking sync metadata into app data', () => {
  const { api } = loadSync();
  const input = {
    schemaVersion: 3,
    groups: [{ id: 'g1', name: '常用', createdAt: '2026-01-01T00:00:00.000Z' }],
    links: [{ id: 'l1', url: 'https://example.com/a#section', title: 'Example', groupId: 'g1', createdAt: '2026-01-01T00:00:00.000Z' }],
  };
  const document = api.buildLocalDocument(input, null);
  const appData = api.toQuickLinkData(document);
  assert.equal(appData.groups.length, 1);
  assert.equal(appData.groups[0].id, 'g1');
  assert.equal(appData.links.length, 1);
  assert.equal(appData.links[0].id, 'l1');
  assert.equal(appData.links[0].title, 'Example');
  assert.equal('updatedAt' in appData.links[0], false);
  assert.equal('order' in appData.groups[0], false);
});

test('mergeDocuments prefers the latest edit and deduplicates same-name groups and URLs', () => {
  const { api } = loadSync();
  const older = '2026-10-17T08:00:00.000Z';
  const newer = '2026-10-17T08:05:00.000Z';
  const remote = {
    schemaVersion: 1,
    groups: [group('g-cloud', '常用', older, 0)],
    links: [link('l-cloud', 'https://example.com/path', 'g-cloud', '旧标题', older, 0)],
    tombstones: [],
  };
  const local = {
    schemaVersion: 1,
    groups: [group('g-local', '常用', newer, 0), group('g-dev', '开发', newer, 1)],
    links: [link('l-local', 'https://example.com/path', 'g-local', '新标题', newer, 0)],
    tombstones: [],
  };
  const merged = api.mergeDocuments(local, remote);
  assert.equal(merged.groups.filter(item => item.name === '常用').length, 1);
  assert.equal(merged.groups.length, 2);
  assert.equal(merged.links.length, 1);
  assert.equal(merged.links[0].title, '新标题');
  assert.ok(merged.groups.some(item => item.name === '开发'));
});

test('a newer delete tombstone prevents a stale remote item from being resurrected', () => {
  const { api } = loadSync();
  const remote = {
    schemaVersion: 1,
    groups: [group('g1', '常用', '2026-10-17T08:00:00.000Z')],
    links: [link('l1', 'https://example.com', 'g1', 'Example', '2026-10-17T08:00:00.000Z')],
    tombstones: [],
  };
  const local = {
    schemaVersion: 1,
    groups: [group('g1', '常用', '2026-10-17T08:00:00.000Z')],
    links: [],
    tombstones: [{ kind: 'link', id: 'l1', deletedAt: '2026-10-17T08:10:00.000Z' }],
  };
  const merged = api.mergeDocuments(local, remote);
  assert.equal(merged.links.length, 0);
  assert.ok(merged.tombstones.some(item => item.id === 'l1'));
});

test('a newer restore/edit can supersede an older tombstone', () => {
  const { api } = loadSync();
  const document = {
    schemaVersion: 1,
    groups: [group('g1', '常用', '2026-10-17T08:00:00.000Z')],
    links: [link('l1', 'https://example.com', 'g1', 'Restored', '2026-10-17T08:12:00.000Z')],
    tombstones: [{ kind: 'link', id: 'l1', deletedAt: '2026-10-17T08:10:00.000Z' }],
  };
  const merged = api.mergeDocuments(document, { schemaVersion: 1, groups: [], links: [], tombstones: [] });
  assert.equal(merged.links.length, 1);
  assert.equal(merged.links[0].title, 'Restored');
});

test('first sync uploads local favorites, re-reads the cloud row and keeps authenticated headers', async () => {
  const userId = '11111111-1111-4111-8111-111111111111';
  const config = {
    supabaseUrl: 'https://sample-project.supabase.co',
    publishableKey: 'sb_publishable_test-key',
  };
  const localData = {
    schemaVersion: 3,
    groups: [{ id: 'group-1', name: '常用', createdAt: '2026-10-17T08:00:00.000Z' }],
    links: [{
      id: 'link-1',
      url: 'https://example.com/',
      title: 'Example',
      groupId: 'group-1',
      createdAt: '2026-10-17T08:00:00.000Z',
      description: '',
      favicon: '',
      category: '',
      badge: '',
      color: '',
      metadataSource: '',
    }],
  };

  let remoteRow = null;
  const calls = [];
  const response = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(data); },
  });
  const { api, stored } = loadSync(config, {
    initialStorage: {
      quickLinkData: localData,
      tabOutSyncSession: {
        userId,
        email: 'test@example.com',
        accessToken: 'test-user-jwt',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    },
    fetch: async (requestUrl, init) => {
      const url = new URL(requestUrl);
      const method = init.method || 'GET';
      calls.push({ url, method, headers: init.headers, body: init.body ? JSON.parse(init.body) : null });
      assert.equal(init.headers.apikey, config.publishableKey);

      if (url.pathname !== '/rest/v1/quick_link_sync_documents') {
        throw new Error('Unexpected endpoint: ' + url.pathname);
      }

      if (method === 'GET') {
        assert.equal(init.headers.Authorization, 'Bearer test-user-jwt');
        return response(remoteRow ? [remoteRow] : []);
      }
      if (method === 'POST') {
        assert.equal(init.headers.Authorization, 'Bearer test-user-jwt');
        remoteRow = {
          ...JSON.parse(init.body),
          revision: 1,
          updated_at: '2026-10-17T08:30:00.000Z',
        };
        return response([remoteRow]);
      }
      throw new Error('Unexpected method: ' + method);
    },
  });

  const result = await api.syncNow();
  assert.equal(result.status, 'synced');
  assert.equal(result.count, 1);
  assert.equal(remoteRow.user_id, userId);
  assert.equal(remoteRow.document.links[0].url, 'https://example.com/');
  assert.equal(stored.quickLinkData.links.length, 1);
  assert.equal(stored.tabOutSyncDocument.ownerId, userId);
  assert.equal(calls.filter(call => call.method === 'GET').length, 2);
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
});

test('joining an existing account merges local and cloud favorites before committing the merged document', async () => {
  const userId = '22222222-2222-4222-8222-222222222222';
  const config = {
    supabaseUrl: 'https://sample-project.supabase.co',
    publishableKey: 'sb_publishable_test-key',
  };
  const localData = {
    schemaVersion: 3,
    groups: [{ id: 'local-group', name: '常用', createdAt: '2026-10-17T08:00:00.000Z' }],
    links: [{
      id: 'local-link',
      url: 'https://local.example/',
      title: 'Local favorite',
      groupId: 'local-group',
      createdAt: '2026-10-17T08:00:00.000Z',
    }],
  };
  let remoteRow = {
    user_id: userId,
    revision: 5,
    updated_at: '2026-10-17T07:00:00.000Z',
    document: {
      schemaVersion: 1,
      groups: [group('cloud-group', '常用', '2026-10-17T07:00:00.000Z')],
      links: [link('cloud-link', 'https://cloud.example/', 'cloud-group', 'Cloud favorite', '2026-10-17T07:00:00.000Z')],
      tombstones: [],
    },
  };
  const response = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(data); },
  });
  const { api, stored } = loadSync(config, {
    initialStorage: {
      quickLinkData: localData,
      tabOutSyncSession: {
        userId,
        email: 'test@example.com',
        accessToken: 'test-user-jwt',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    },
    fetch: async (requestUrl, init) => {
      const url = new URL(requestUrl);
      const method = init.method || 'GET';
      if (url.pathname !== '/rest/v1/quick_link_sync_documents') {
        throw new Error('Unexpected endpoint: ' + url.pathname);
      }
      assert.equal(init.headers.Authorization, 'Bearer test-user-jwt');
      if (method === 'GET') return response([remoteRow]);
      if (method === 'PATCH') {
        const expectedRevision = Number(String(url.searchParams.get('revision') || '').replace(/^eq\./, ''));
        if (expectedRevision !== remoteRow.revision) return response([]);
        remoteRow.document = JSON.parse(init.body).document;
        remoteRow.revision += 1;
        remoteRow.updated_at = '2026-10-17T08:30:00.000Z';
        return response([remoteRow]);
      }
      throw new Error('Unexpected method: ' + method);
    },
  });

  const result = await api.syncNow();
  assert.equal(result.status, 'synced');
  assert.equal(result.count, 2);
  assert.equal(remoteRow.revision, 6);
  assert.deepEqual(
    remoteRow.document.links.map(item => item.id).sort(),
    ['cloud-link', 'local-link'],
  );
  assert.equal(remoteRow.document.groups.length, 1);
  assert.ok(remoteRow.document.links.every(item => item.groupId === 'local-group'));
  assert.equal(stored.quickLinkData.links.length, 2);
  assert.equal(stored.quickLinkData.groups.length, 1);
});

test('Supabase config accepts only HTTPS managed project URLs with a client key', () => {
  assert.equal(loadSync({
    supabaseUrl: 'https://sample-project.supabase.co',
    publishableKey: 'sb_publishable_test-key',
  }).api.isConfigured(), true);

  assert.equal(loadSync({
    supabaseUrl: 'http://sample-project.supabase.co',
    publishableKey: 'sb_publishable_test-key',
  }).api.isConfigured(), false);

  assert.equal(loadSync({
    supabaseUrl: 'https://sample-project.supabase.co.evil.example',
    publishableKey: 'sb_publishable_test-key',
  }).api.isConfigured(), false);

  assert.equal(loadSync({
    supabaseUrl: 'https://sample-project.supabase.co',
  }).api.isConfigured(), false);

  assert.equal(loadSync({
    supabaseUrl: 'https://sample-project.supabase.co',
    publishableKey: 'sb_secret_do-not-use-in-extension',
  }).api.isConfigured(), false);

  const legacyServiceRolePayload = Buffer.from(JSON.stringify({ role: 'service_role' })).toString('base64url');
  assert.equal(loadSync({
    supabaseUrl: 'https://sample-project.supabase.co',
    anonKey: 'header.' + legacyServiceRolePayload + '.signature',
  }).api.isConfigured(), false);
});

test('local removals become tombstones and unchanged items keep their timestamp', () => {
  const { api } = loadSync();
  const previous = {
    schemaVersion: 1,
    groups: [group('g1', '常用', '2026-10-17T08:00:00.000Z')],
    links: [link('l1', 'https://example.com', 'g1', 'Example', '2026-10-17T08:00:00.000Z')],
    tombstones: [],
  };

  const current = {
    schemaVersion: 3,
    groups: [{ id: 'g1', name: '常用', createdAt: '2026-01-01T00:00:00.000Z' }],
    links: [],
  };
  const next = api.buildLocalDocument(current, previous);
  assert.equal(next.links.length, 0);
  assert.ok(next.tombstones.some(item => item.kind === 'link' && item.id === 'l1'));
  assert.equal(next.groups[0].updatedAt, previous.groups[0].updatedAt);
});

test('local favorite edits persist an owner-scoped pending sync marker for the background worker', async () => {
  const config = {
    supabaseUrl: 'https://sample-project.supabase.co',
    publishableKey: 'sb_publishable_test-key',
  };
  const userId = '33333333-3333-4333-8333-333333333333';
  const { api, stored, fetchCount } = loadSync(config, {
    setTimeout: () => 123,
    initialStorage: {
      quickLinkData: {
        schemaVersion: 3,
        groups: [{ id: 'group-1', name: '常用', createdAt: '2026-10-17T08:00:00.000Z' }],
        links: [],
      },
      tabOutSyncSession: {
        userId,
        email: 'test@example.com',
        accessToken: 'test-user-jwt',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    },
  });

  const queued = await api.recordLocalDataChange({
    schemaVersion: 3,
    groups: [{ id: 'group-1', name: '常用', createdAt: '2026-10-17T08:00:00.000Z' }],
    links: [{
      id: 'link-queued',
      url: 'https://queued.example/',
      title: 'Queued favorite',
      groupId: 'group-1',
      createdAt: '2026-10-17T08:00:00.000Z',
    }],
  });

  assert.equal(queued, true);
  assert.equal(stored.tabOutSyncPending.ownerId, userId);
  assert.ok(stored.tabOutSyncPending.token);
  assert.equal(stored.tabOutSyncDocument.document.links[0].id, 'link-queued');
  assert.equal(fetchCount(), 0);
});

test('MV3 Service Worker can sync without a DOM and schedules a durable retry alarm on failure', async () => {
  const config = {
    supabaseUrl: 'https://sample-project.supabase.co',
    publishableKey: 'sb_publishable_test-key',
  };
  const userId = '44444444-4444-4444-8444-444444444444';
  const { api, alarmCalls, fetchCount } = loadSync(config, {
    worker: true,
    initialStorage: {
      quickLinkData: { schemaVersion: 3, groups: [], links: [] },
      tabOutSyncSession: {
        userId,
        email: 'test@example.com',
        accessToken: 'test-user-jwt',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 60 * 60 * 1000,
      },
    },
  });

  await assert.rejects(api.syncNow(), /unexpected fetch/);
  assert.equal(fetchCount(), 1);
  assert.equal(alarmCalls.length, 1);
  assert.equal(alarmCalls[0].name, 'tab-out-cloud-sync-retry');
  assert.ok(alarmCalls[0].info.delayInMinutes >= 0.5);
});

test('missing Supabase config keeps sync disabled and never makes a network request', async () => {
  const { api, fetchCount } = loadSync();
  assert.equal(api.isConfigured(), false);
  await api.recordLocalDataChange({ groups: [], links: [] });
  assert.equal(fetchCount(), 0);
});
