const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const extensionRoot = process.env.TAB_OUT_EXTENSION_ROOT
  ? path.resolve(process.env.TAB_OUT_EXTENSION_ROOT)
  : path.resolve(__dirname, '../extension');

const TEST_HOOK = 'globalThis.__tabOutQuickLinkFormTest = { cleanPastedUrl, buildUrlSuggestions, shouldExpandFavoriteAdvanced, getQuickLinkUrlValidationError, resolveGroupRecommendation };';

function loadQuickLinkFormHelpers({
  tabs = [],
  history = [],
  tabsError = false,
  noHistory = false,
  preferences = null,
  categories = null,
  failCategories = false,
} = {}) {
  const appPath = path.join(extensionRoot, 'app.js');
  const source = readFileSync(appPath, 'utf8').replace(
    /renderDashboard\(\);(?=\s*(?:\/\/# sourceMappingURL=[^\r\n]+\s*)?$)/,
    TEST_HOOK
  );
  const listener = { addListener() {} };
  const stored = preferences ? { tabOutGroupPreferences: { ...preferences } } : {};
  const context = {
    chrome: {
      runtime: { id: 'test-extension', getURL: resource => `chrome-extension://test-extension${resource.startsWith('/') ? resource : `/${resource}`}` },
      tabs: {
        onCreated: listener,
        onRemoved: listener,
        onUpdated: listener,
        onActivated: listener,
        query: tabsError
          ? async () => { throw new Error('tabs unavailable'); }
          : async () => tabs,
      },
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
    },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    window: { addEventListener() {} },
    console: { warn() {}, log() {}, error() {} },
    HTMLImageElement: class HTMLImageElement {},
    URL,
    Date,
    setTimeout,
    clearTimeout,
  };
  if (!noHistory) {
    context.chrome.history = {
      onVisited: listener,
      onVisitRemoved: listener,
      search: async () => history,
    };
  }

  // Load real dependency modules into the same realm for high-fidelity behavior.
  const preferencePath = path.join(extensionRoot, 'services', 'groupPreferenceService.js');
  vm.runInNewContext(readFileSync(preferencePath, 'utf8'), context, { filename: preferencePath });
  const metadataPath = path.join(extensionRoot, 'favorites', 'favorites-metadata.js');
  vm.runInNewContext(readFileSync(metadataPath, 'utf8'), context, { filename: metadataPath });

  if (categories || failCategories) {
    context.TabOutBackgroundClient = {
      getCategories: async hostnames => {
        if (failCategories) throw new Error('classification unavailable');
        return new Map(hostnames.map(hostname => [hostname, categories?.[hostname] || 'Other']));
      },
    };
  }

  vm.runInNewContext(source, context, { filename: appPath });
  return context.__tabOutQuickLinkFormTest;
}

// ---- cleanPastedUrl ----

test('cleanPastedUrl removes tracking parameters and keeps the rest', () => {
  const { cleanPastedUrl } = loadQuickLinkFormHelpers();
  assert.equal(
    cleanPastedUrl('https://a.com/p?utm_source=x&id=1'),
    'https://a.com/p?id=1'
  );
  assert.equal(
    cleanPastedUrl('https://a.com/p?UTM_Medium=news&fbclid=abc&id=2'),
    'https://a.com/p?id=2'
  );
  assert.equal(
    cleanPastedUrl('https://a.com/p?gclid=x&ref=home&ref_src=app&keep=1'),
    'https://a.com/p?keep=1'
  );
});

test('cleanPastedUrl drops the dangling question mark when all params are tracking', () => {
  const { cleanPastedUrl } = loadQuickLinkFormHelpers();
  assert.equal(cleanPastedUrl('https://a.com/p?utm_source=x'), 'https://a.com/p');
  assert.equal(cleanPastedUrl('https://a.com/p?utm_source=x#sec'), 'https://a.com/p#sec');
});

test('cleanPastedUrl trims whitespace but otherwise leaves text untouched', () => {
  const { cleanPastedUrl } = loadQuickLinkFormHelpers();
  assert.equal(cleanPastedUrl('  https://a.com/p?q=1  '), 'https://a.com/p?q=1');
  assert.equal(cleanPastedUrl('hello world'), 'hello world');
  assert.equal(cleanPastedUrl(''), '');
  assert.equal(cleanPastedUrl(null), '');
});

test('cleanPastedUrl keeps non-http protocols and protocol-less input unchanged when nothing to clean', () => {
  const { cleanPastedUrl } = loadQuickLinkFormHelpers();
  assert.equal(cleanPastedUrl('ftp://a.com?utm_source=x'), 'ftp://a.com?utm_source=x');
  assert.equal(cleanPastedUrl('chrome://extensions'), 'chrome://extensions');
  assert.equal(cleanPastedUrl('a.com/p?q=1'), 'a.com/p?q=1');
});

test('cleanPastedUrl normalizes protocol-less URLs when tracking params were removed', () => {
  const { cleanPastedUrl } = loadQuickLinkFormHelpers();
  assert.equal(cleanPastedUrl('a.com/p?fbclid=abc&q=1'), 'https://a.com/p?q=1');
});

// ---- buildUrlSuggestions ----

test('buildUrlSuggestions merges open tabs first, then history, deduplicated', async () => {
  const helpers = loadQuickLinkFormHelpers({
    tabs: [
      { url: 'https://tab-a.com/', title: 'Tab A' },
      { url: 'https://shared.com/x', title: 'Shared Tab' },
      { url: 'chrome://extensions', title: 'Extensions' },
      { url: '', title: 'Empty' },
    ],
    history: [
      { url: 'https://shared.com/x', title: 'Shared History' },
      { url: 'https://hist-b.com/', title: 'Hist B' },
      { url: 'about:blank', title: 'Blank' },
    ],
  });
  const suggestions = await helpers.buildUrlSuggestions();
  // Cross-realm arrays fail prototype-strict deepEqual; rebuild with local Array.from.
  assert.deepEqual(Array.from(suggestions, item => ({ url: item.url, title: item.title })), [
    { url: 'https://tab-a.com/', title: 'Tab A' },
    { url: 'https://shared.com/x', title: 'Shared Tab' },
    { url: 'https://hist-b.com/', title: 'Hist B' },
  ]);
});

test('buildUrlSuggestions caps results and survives failing chrome APIs', async () => {
  const many = Array.from({ length: 150 }, (_, index) => ({
    url: `https://site-${index}.com/`,
    title: `Site ${index}`,
  }));
  const helpers = loadQuickLinkFormHelpers({ tabs: many, history: many });
  const suggestions = await helpers.buildUrlSuggestions();
  assert.equal(suggestions.length, 100);
  assert.equal(suggestions[0].url, 'https://site-0.com/');
});

test('buildUrlSuggestions returns an empty list when tabs and history are unavailable', async () => {
  const helpers = loadQuickLinkFormHelpers({ tabsError: true, noHistory: true });
  const suggestions = await helpers.buildUrlSuggestions();
  assert.equal(suggestions.length, 0);
});

// ---- shouldExpandFavoriteAdvanced ----

test('shouldExpandFavoriteAdvanced expands only for user-customized links', () => {
  const { shouldExpandFavoriteAdvanced } = loadQuickLinkFormHelpers();
  assert.equal(shouldExpandFavoriteAdvanced(null), false, 'create mode stays collapsed');
  assert.equal(shouldExpandFavoriteAdvanced({}), false, 'missing source stays collapsed');
  assert.equal(shouldExpandFavoriteAdvanced({ metadataSource: 'auto' }), false, 'auto stays collapsed');
  assert.equal(shouldExpandFavoriteAdvanced({ metadataSource: '' }), false, 'empty stays collapsed');
  assert.equal(shouldExpandFavoriteAdvanced({ metadataSource: 'custom' }), true, 'custom expands');
});

// ---- getQuickLinkUrlValidationError ----

test('getQuickLinkUrlValidationError maps empty, malformed and non-web URLs to codes', () => {
  const { getQuickLinkUrlValidationError } = loadQuickLinkFormHelpers();

  assert.equal(getQuickLinkUrlValidationError('').code, 'missing-url');
  assert.equal(getQuickLinkUrlValidationError('   ').code, 'missing-url');
  assert.equal(getQuickLinkUrlValidationError(null).code, 'missing-url');

  assert.equal(getQuickLinkUrlValidationError('notaurl').code, 'invalid-url');
  assert.equal(getQuickLinkUrlValidationError('https://a b.com').code, 'invalid-url');

  assert.equal(getQuickLinkUrlValidationError('ftp://a.com/x').code, 'unsupported-protocol');
  assert.equal(getQuickLinkUrlValidationError('chrome://extensions').code, 'unsupported-protocol');
});

test('getQuickLinkUrlValidationError accepts valid web URLs including local targets', () => {
  const { getQuickLinkUrlValidationError } = loadQuickLinkFormHelpers();

  assert.equal(getQuickLinkUrlValidationError('https://a.com/p?q=1'), null);
  assert.equal(getQuickLinkUrlValidationError('a.com/p'), null, 'protocol-less is normalized');
  assert.equal(getQuickLinkUrlValidationError('http://localhost:3000/x'), null);
  assert.equal(getQuickLinkUrlValidationError('http://192.168.1.1:8080/'), null);
  assert.equal(getQuickLinkUrlValidationError('  https://b.cn/#frag  '), null);
});

// ---- resolveGroupRecommendation ----

const GROUPS = [
  { id: 'g1', name: '工作' },
  { id: 'g2', name: '开发' },
  { id: 'g3', name: 'AI' },
];

test('resolveGroupRecommendation prefers the stored user preference over AI category', async () => {
  const { resolveGroupRecommendation } = loadQuickLinkFormHelpers({
    preferences: { 'github.com': { groupName: '工作', updatedAt: '2026-01-01T00:00:00.000Z' } },
    categories: { 'github.com': 'Development' },
  });
  const recommendation = await resolveGroupRecommendation('https://www.github.com/org/repo', GROUPS);
  assert.equal(recommendation.groupName, '工作');
  assert.equal(recommendation.source, 'preference');
});

test('resolveGroupRecommendation falls back to category when the preferred group no longer exists', async () => {
  const { resolveGroupRecommendation } = loadQuickLinkFormHelpers({
    preferences: { 'github.com': { groupName: '已删除的分组', updatedAt: '2026-01-01T00:00:00.000Z' } },
    categories: { 'github.com': 'Development' },
  });
  const recommendation = await resolveGroupRecommendation('https://github.com/', GROUPS);
  assert.equal(recommendation.groupName, '开发');
  assert.equal(recommendation.source, 'category');
});

test('resolveGroupRecommendation maps service categories to local group names', async () => {
  const { resolveGroupRecommendation } = loadQuickLinkFormHelpers({
    categories: { 'chatgpt.com': 'AI Tools' },
  });
  const recommendation = await resolveGroupRecommendation('https://chatgpt.com/', GROUPS);
  assert.equal(recommendation.groupName, 'AI');
  assert.equal(recommendation.source, 'category');
});

test('resolveGroupRecommendation returns null for Other category, bad URLs and failing services', async () => {
  const other = loadQuickLinkFormHelpers({ categories: { 'random-site.com': 'Other' } });
  assert.equal(await other.resolveGroupRecommendation('https://random-site.com/', GROUPS), null);

  const failing = loadQuickLinkFormHelpers({ failCategories: true });
  assert.equal(await failing.resolveGroupRecommendation('https://any-site.com/', GROUPS), null);

  const noClient = loadQuickLinkFormHelpers();
  assert.equal(await noClient.resolveGroupRecommendation('https://any-site.com/', GROUPS), null);

  const withClient = loadQuickLinkFormHelpers({ categories: {} });
  assert.equal(await withClient.resolveGroupRecommendation('not a url', GROUPS), null);
  assert.equal(await withClient.resolveGroupRecommendation('', GROUPS), null);
});
