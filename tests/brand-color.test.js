const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const modulePath = path.resolve(__dirname, '../extension/favorites/favorites-metadata.js');

function loadMetadata() {
  const context = { URL };
  context.globalThis = context;
  vm.runInNewContext(readFileSync(modulePath, 'utf8'), context, { filename: modulePath });
  return context.TabOutFavoritesMetadata;
}

const HEX_PATTERN = /^#[0-9a-f]{6}$/;

test('generateBrandColor returns a valid lowercase 6-digit hex color', () => {
  const metadata = loadMetadata();
  for (let index = 0; index < 30; index += 1) {
    assert.match(metadata.generateBrandColor(), HEX_PATTERN);
  }
});

test('generateBrandColor produces distinct colors across calls', () => {
  const metadata = loadMetadata();
  const colors = new Set(Array.from({ length: 30 }, () => metadata.generateBrandColor()));
  assert.ok(colors.size >= 5, `expected variety, got ${colors.size} distinct colors`);
});

test('inferFavoriteMetadata keeps known-site brand colors and returns empty for unknown sites', () => {
  const metadata = loadMetadata();
  const known = metadata.inferFavoriteMetadata({ url: 'https://github.com/x', groupName: '开发' });
  assert.equal(known.color, '#65758b');

  const unknown = metadata.inferFavoriteMetadata({ url: 'https://some-unknown-site.example.com/', groupName: '开发' });
  assert.equal(unknown.color, '', 'unknown sites no longer fall back to the category color');
});

test('enrichFavorite assigns a random brand color when none was chosen', () => {
  const metadata = loadMetadata();
  const link = metadata.enrichFavorite({
    url: 'https://some-unknown-site.example.com/',
    title: 'Example',
    groupId: 'g1',
    color: '',
  }, '开发');

  assert.match(link.color, HEX_PATTERN);
  assert.notEqual(link.color, '#159b96', 'replaces the previous 开发 category color fallback');

  // Same input enriched twice yields different random colors.
  const again = metadata.enrichFavorite({
    url: 'https://another-unknown-site.example.com/',
    title: 'Example',
    groupId: 'g1',
    color: '',
  }, '开发');
  assert.match(again.color, HEX_PATTERN);
  assert.notEqual(again.color, link.color, 'random assignment varies between links');
});

test('enrichFavorite preserves known-site brand colors and user-chosen colors', () => {
  const metadata = loadMetadata();

  const known = metadata.enrichFavorite({
    url: 'https://github.com/x',
    title: 'GitHub',
    groupId: 'g1',
    color: '',
  }, '常用');
  assert.equal(known.color, '#65758b');

  const custom = metadata.enrichFavorite({
    url: 'https://some-unknown-site.example.com/',
    title: 'Example',
    groupId: 'g1',
    color: '#abc123',
  }, '开发');
  assert.equal(custom.color, '#abc123');
});

test('enrichFavorite falls back to a random color when the stored color is invalid', () => {
  const metadata = loadMetadata();
  const link = metadata.enrichFavorite({
    url: 'https://some-unknown-site.example.com/',
    title: 'Example',
    groupId: 'g1',
    color: 'not-a-color',
  }, '开发');
  assert.match(link.color, HEX_PATTERN);
});
