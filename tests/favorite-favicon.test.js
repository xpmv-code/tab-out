const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const extensionRoot = process.env.TAB_OUT_EXTENSION_ROOT
  ? path.resolve(process.env.TAB_OUT_EXTENSION_ROOT)
  : path.resolve(__dirname, '../extension');

function loadAppFaviconHelpers() {
  const appPath = path.join(extensionRoot, 'app.js');
  const source = readFileSync(appPath, 'utf8').replace(
    /renderDashboard\(\);(?=\s*(?:\/\/# sourceMappingURL=[^\r\n]+\s*)?$)/,
    'globalThis.__tabOutFaviconTest = { getLocalFaviconUrl, getQuickLinkFaviconDomain, getQuickLinkFaviconUrl, getQuickLinkFaviconChromeFallbackUrl, getQuickLinkFaviconFallbackUrl, handleFaviconLoadError };'
  );
  const listener = { addListener() {} };
  const context = {
    chrome: {
      runtime: { id: 'test-extension', getURL: resource => `chrome-extension://test-extension${resource.startsWith('/') ? resource : `/${resource}`}` },
      tabs: { onCreated: listener, onRemoved: listener, onUpdated: listener, onActivated: listener },
      history: { onVisited: listener, onVisitRemoved: listener },
    },
    document: { addEventListener() {}, getElementById() { return null; }, querySelectorAll() { return []; } },
    window: { addEventListener() {} },
    HTMLImageElement: class HTMLImageElement {},
    URL,
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, context, { filename: appPath });
  return context.__tabOutFaviconTest;
}

function loadFavoritesRenderer() {
  const rendererPath = path.join(extensionRoot, 'favorites', 'favorites-renderer.js');
  const context = {};
  context.globalThis = context;
  vm.runInNewContext(readFileSync(rendererPath, 'utf8'), context, { filename: rendererPath });
  return context.TabOutFavoritesRenderer;
}

const app = loadAppFaviconHelpers();

test('favorite favicon URL uses favicon.im with the normalized domain and 404 fallback control', () => {
  const faviconUrl = new URL(app.getQuickLinkFaviconUrl('https://www.Example.com/some/page?q=a&v=1'));
  assert.equal(faviconUrl.origin, 'https://a.favicon.im');
  assert.equal(faviconUrl.pathname, '/example.com');
  assert.equal(faviconUrl.searchParams.get('throw-error-on-404'), 'true');
  assert.equal(app.getQuickLinkFaviconDomain('https://platform.deepseek.com/path'), 'platform.deepseek.com');
  assert.equal(app.getQuickLinkFaviconDomain('file:///tmp/page.html'), '');
  assert.equal(app.getQuickLinkFaviconDomain('http://localhost:3000/path'), '');
  assert.equal(app.getQuickLinkFaviconDomain('http://192.168.1.1:8080/'), '');
  assert.equal(app.getQuickLinkFaviconUrl('not a url'), '');
});
test('direct favicon fallback uses the target website origin and rejects unsupported URLs', () => {
  assert.equal(app.getQuickLinkFaviconFallbackUrl('https://example.com:8443/a/b'), 'https://example.com:8443/favicon.ico');
  assert.equal(app.getQuickLinkFaviconFallbackUrl('http://localhost:3000/page'), 'http://localhost:3000/favicon.ico');
  assert.equal(app.getQuickLinkFaviconFallbackUrl('file:///tmp/page.html'), '');
  assert.equal(app.getQuickLinkFaviconFallbackUrl('not a url'), '');
});

test('favicon loading advances through three fallbacks before revealing the text fallback', () => {
  const apiFavicon = 'https://a.favicon.im/example.com?throw-error-on-404=true';
  const chromeFavicon = 'chrome-extension://test-extension/_favicon/?pageUrl=https%3A%2F%2Fexample.com&size=32';
  const image = {
    src: 'chrome-extension://test-extension/custom-icon.png',
    dataset: {
      fallbackSrc: apiFavicon,
      fallbackSrcNext: chromeFavicon,
      fallbackSrcThird: 'https://example.com/favicon.ico',
    },
    hidden: false,
  };

  assert.equal(app.handleFaviconLoadError(image), true);
  assert.equal(image.src, apiFavicon);
  assert.equal(image.dataset.fallbackSrc, chromeFavicon);
  assert.equal(image.dataset.fallbackSrcNext, 'https://example.com/favicon.ico');
  assert.equal('fallbackSrcThird' in image.dataset, false);

  assert.equal(app.handleFaviconLoadError(image), true);
  assert.equal(image.src, chromeFavicon);
  assert.equal(image.dataset.fallbackSrc, 'https://example.com/favicon.ico');
  assert.equal('fallbackSrcNext' in image.dataset, false);

  assert.equal(app.handleFaviconLoadError(image), true);
  assert.equal(image.src, 'https://example.com/favicon.ico');
  assert.equal('fallbackSrc' in image.dataset, false);

  assert.equal(app.handleFaviconLoadError(image), false);
  assert.equal(image.hidden, true);
});
test('favorite cards render favicon.im first with Chrome and website fallbacks', () => {
test('local favorites avoid the external API and use Chrome favicon as primary', () => {
  const renderer = loadFavoritesRenderer();
  const html = renderer.renderFavorites({
    groups: [{ id: 'g1', name: '本地' }],
    links: [{ id: 'l1', url: 'http://192.168.1.1:8080/', title: 'Router', groupId: 'g1', color: '#123456' }],
  }, renderer.ALL_GROUP_ID, {
    escapeAttr: value => String(value).replace(/&/g, '&amp;').replace(/\"/g, '&quot;'),
    escapeHtml: value => String(value),
    getFaviconUrl: url => app.getQuickLinkFaviconUrl(url),
    getFaviconFallbackUrl: url => app.getQuickLinkFaviconChromeFallbackUrl(url),
    getFaviconFallbackUrlNext: url => app.getQuickLinkFaviconFallbackUrl(url),
    getInitial: title => title[0],
  });

  assert.ok(!html.includes('a.favicon.im'));
  assert.ok(html.includes('src=\"chrome-extension://test-extension/_favicon/'));
  assert.ok(html.includes('data-fallback-src=\"http://192.168.1.1:8080/favicon.ico\"'));
});

  const renderer = loadFavoritesRenderer();
  const html = renderer.renderFavorites({
    groups: [{ id: 'g1', name: '常用' }],
    links: [{ id: 'l1', url: 'https://example.com/path', title: 'Example', groupId: 'g1', color: '#123456' }],
  }, renderer.ALL_GROUP_ID, {
    escapeAttr: value => String(value).replace(/&/g, '&amp;').replace(/\"/g, '&quot;'),
    escapeHtml: value => String(value),
    getFaviconUrl: url => app.getQuickLinkFaviconUrl(url),
    getFaviconFallbackUrl: url => app.getQuickLinkFaviconChromeFallbackUrl(url),
    getFaviconFallbackUrlNext: url => app.getQuickLinkFaviconFallbackUrl(url),
    getInitial: title => title[0],
  });

  assert.ok(html.includes('src="https://a.favicon.im/example.com?throw-error-on-404=true"'));
  assert.ok(html.includes('data-fallback-src="chrome-extension://test-extension/_favicon/'));
  assert.ok(html.includes('data-fallback-src-next="https://example.com/favicon.ico"'));
  assert.ok(html.includes('loading="lazy"'));
  assert.ok(html.includes('class="quick-link-letter"'));
});