const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const modulePath = path.resolve(__dirname, '../extension/theme.js');

function loadTheme({ storedMode = null, prefersDark = false } = {}) {
  const source = readFileSync(modulePath, 'utf8');
  const store = new Map();
  if (storedMode !== null) store.set('tabOutThemeMode', storedMode);
  const documentElement = { dataset: {} };
  const context = {
    localStorage: {
      getItem: key => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: key => store.delete(key),
    },
    matchMedia: () => ({
      matches: prefersDark,
      addEventListener() {},
    }),
    document: { documentElement },
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: modulePath });
  return { api: context.TabOutTheme, documentElement, store };
}

test('resolveMode maps system to the OS scheme and keeps explicit choices', () => {
  const { api } = loadTheme();
  assert.equal(api.resolveMode('system', true), 'dark');
  assert.equal(api.resolveMode('system', false), 'light');
  assert.equal(api.resolveMode('light', true), 'light', 'explicit light wins over dark OS');
  assert.equal(api.resolveMode('dark', false), 'dark', 'explicit dark wins over light OS');
  assert.equal(api.resolveMode('bogus', true), 'dark', 'invalid falls back to system behavior');
  assert.equal(api.resolveMode(undefined, false), 'light');
});

test('load applies the resolved theme before first paint', () => {
  const light = loadTheme({ prefersDark: false });
  assert.equal(light.documentElement.dataset.theme, 'light');

  const dark = loadTheme({ prefersDark: true });
  assert.equal(dark.documentElement.dataset.theme, 'dark');

  const forced = loadTheme({ storedMode: 'light', prefersDark: true });
  assert.equal(forced.documentElement.dataset.theme, 'light', 'stored choice overrides OS');
});

test('getMode validates storage and falls back to system', () => {
  assert.equal(loadTheme().api.getMode(), 'system', 'empty storage');
  assert.equal(loadTheme({ storedMode: 'dark' }).api.getMode(), 'dark');
  assert.equal(loadTheme({ storedMode: 'neon' }).api.getMode(), 'system', 'invalid value');
});

test('setMode persists, applies and returns the resolved theme', () => {
  const { api, documentElement, store } = loadTheme({ prefersDark: true });
  assert.equal(api.setMode('light'), 'light');
  assert.equal(store.get('tabOutThemeMode'), 'light');
  assert.equal(documentElement.dataset.theme, 'light');

  assert.equal(api.setMode('system'), 'dark', 'system resolves against dark OS');
  assert.equal(store.get('tabOutThemeMode'), 'system');
  assert.equal(documentElement.dataset.theme, 'dark');

  assert.equal(api.setMode('bogus'), 'dark', 'invalid input normalizes to system');
  assert.equal(store.get('tabOutThemeMode'), 'system');
});

test('theme API surface is frozen and complete', () => {
  const { api } = loadTheme();
  assert.equal(Object.isFrozen(api), true);
  for (const name of ['resolveMode', 'getMode', 'setMode', 'apply']) {
    assert.equal(typeof api[name], 'function', `${name} is exposed`);
  }
});
