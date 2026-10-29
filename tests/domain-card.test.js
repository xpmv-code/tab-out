const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const extensionRoot = path.resolve(__dirname, '../extension');

function loadDomainCardRenderer() {
  const appPath = path.join(extensionRoot, 'app.js');
  const source = readFileSync(appPath, 'utf8').replace(
    /renderDashboard\(\);(?=\s*(?:\/\/# sourceMappingURL=[^\r\n]+\s*)?$)/,
    'globalThis.__tabOutTest = { renderDomainCard };'
  );
  const listener = { addListener() {} };
  const context = {
    chrome: {
      runtime: { id: 'test-extension', getURL: path => `chrome-extension://test-extension/${path}` },
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
  return context.__tabOutTest.renderDomainCard;
}

test('domain card preserves dots in an IPv4 address', () => {
  const renderDomainCard = loadDomainCardRenderer();
  const html = renderDomainCard({
    domain: '192.168.3.1',
    tabs: [{ url: 'http://192.168.3.1/html/index.html', title: '华为路由TC7102' }],
  });

  assert.match(html, /<span class="mission-name">192\.168\.3\.1<\/span>/);
});
