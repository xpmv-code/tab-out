const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const modulePath = path.resolve(__dirname, '../extension/services/groupPreferenceService.js');

function loadService({ initialStorage = {}, clockStep = 1000 } = {}) {
  const source = readFileSync(modulePath, 'utf8');
  const stored = { ...initialStorage };
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock);
      else super(...args);
    }
    static now() { return clock; }
  }
  const context = {
    chrome: {
      storage: {
        local: {
          async get(keys) {
            if (typeof keys === 'string') return { [keys]: stored[keys] };
            return { ...stored };
          },
          async set(values) { Object.assign(stored, values); },
          async remove(keys) { (Array.isArray(keys) ? keys : [keys]).forEach(key => delete stored[key]); },
        },
      },
    },
    console: { warn() {}, log() {} },
    URL,
    Date: FakeDate,
    advanceClock(ms) { clock += ms; },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: modulePath });
  return { api: context.TabOutGroupPreferenceService, stored, advanceClock: context.advanceClock };
}

test('normalizeHostname lowercases, strips www and tolerates full URLs', () => {
  const { api } = loadService();
  assert.equal(api.normalizeHostname('https://WWW.Example.com/some/path?q=1'), 'example.com');
  assert.equal(api.normalizeHostname('www.example.com'), 'example.com');
  assert.equal(api.normalizeHostname('Example.COM.'), 'example.com');
  assert.equal(api.normalizeHostname('sub.domain.com/path'), 'sub.domain.com');
  assert.equal(api.normalizeHostname(''), '');
  assert.equal(api.normalizeHostname(null), '');
  assert.equal(api.normalizeHostname('https://not a url'), '');
});

test('record stores the chosen group and get retrieves it', async () => {
  const { api, stored } = loadService();
  assert.equal(await api.record('https://a.com/x?y=1', '开发'), true);
  const entry = await api.get('a.com');
  assert.equal(entry.groupName, '开发');
  assert.equal(entry.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.ok(stored.tabOutGroupPreferences, 'uses its own storage key');
  const viaFullUrl = await api.get('https://www.a.com/other');
  assert.equal(viaFullUrl.groupName, '开发', 'full URL normalizes to the same key');
});

test('record overwrites the previous group and refreshes updatedAt', async () => {
  const { api, advanceClock } = loadService();
  await api.record('a.com', '开发');
  advanceClock(60000);
  await api.record('https://www.a.com/path', '效率');
  const entry = await api.get('a.com');
  assert.equal(entry.groupName, '效率');
  assert.equal(entry.updatedAt, '2026-01-01T00:01:00.000Z');
});

test('record rejects empty hostnames and group names', async () => {
  const { api, stored } = loadService();
  assert.equal(await api.record('', '开发'), false);
  assert.equal(await api.record('a.com', ''), false);
  assert.equal(await api.record('a.com', '   '), false);
  assert.equal(stored.tabOutGroupPreferences, undefined);
});

test('LRU pruning keeps the newest entries at the cap', async () => {
  const { api, advanceClock } = loadService();
  const total = api.MAX_ENTRIES + 5;
  for (let index = 0; index < total; index += 1) {
    await api.record(`site-${index}.com`, '分组');
    advanceClock(1000);
  }
  const all = await api.getAll();
  assert.equal(Object.keys(all).length, api.MAX_ENTRIES);
  assert.equal(all['site-0.com'], undefined, 'oldest entry evicted');
  assert.equal(all['site-4.com'], undefined, 'fifth oldest evicted');
  assert.equal(all['site-5.com'].groupName, '分组', 'newest kept');
  assert.equal(all[`site-${total - 1}.com`].groupName, '分组');
});

test('touching an existing entry protects it from eviction', async () => {
  const { api, advanceClock } = loadService();
  await api.record('keep-me.com', '收藏');
  for (let index = 0; index < api.MAX_ENTRIES; index += 1) {
    advanceClock(1000);
    await api.record(`filler-${index}.com`, '分组');
  }
  advanceClock(1000);
  await api.record('keep-me.com', '收藏');
  for (let index = 0; index < 5; index += 1) {
    advanceClock(1000);
    await api.record(`extra-${index}.com`, '分组');
  }
  const all = await api.getAll();
  assert.equal(all['keep-me.com'].groupName, '收藏');
});

test('clear removes all preference records', async () => {
  const { api, stored } = loadService();
  await api.record('a.com', '开发');
  await api.record('b.com', '娱乐');
  assert.equal(await api.clear(), true);
  // Cross-realm objects fail prototype-strict deepEqual; compare key counts.
  assert.equal(Object.keys(await api.getAll()).length, 0);
  assert.equal(stored.tabOutGroupPreferences, undefined);
});

test('corrupt stored data degrades to an empty map', async () => {
  const { api } = loadService({ initialStorage: { tabOutGroupPreferences: 'not-an-object' } });
  assert.equal(Object.keys(await api.getAll()).length, 0);
  assert.equal(await api.get('a.com'), null);
  await api.record('a.com', '开发');
  assert.equal((await api.get('a.com')).groupName, '开发');
});
