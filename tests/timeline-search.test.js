const assert = require('node:assert/strict');
const { test } = require('node:test');

const { searchTimeline } = require('../extension/timeline-search.js');

test('user can search current tabs and history with AND terms while keeping tree context', () => {
  const snapshot = {
    tabs: [],
    tabTree: [
      {
        id: 1,
        source: 'tab',
        title: 'Research hub',
        url: 'https://example.com/start',
        hostname: 'example.com',
        children: [
          {
            id: 2,
            source: 'tab',
            title: 'Issue tracker',
            url: 'https://github.com/acme/issues/42',
            hostname: 'github.com',
            children: [],
          },
          {
            id: 3,
            source: 'tab',
            title: 'Pull requests',
            url: 'https://github.com/acme/pulls',
            hostname: 'github.com',
            children: [],
          },
        ],
      },
    ],
    sessions: {
      blocks: [
        {
          id: 'session-one',
          records: [
            {
              source: 'history',
              title: 'Issue 42 discussion',
              url: 'https://github.com/acme/issues/42',
              hostname: 'github.com',
            },
            {
              source: 'history',
              title: 'Release notes',
              url: 'https://github.com/acme/releases',
              hostname: 'github.com',
            },
          ],
        },
        {
          id: 'session-two',
          records: [
            {
              source: 'history',
              title: 'Issue tracker',
              url: 'https://example.com/issues',
              hostname: 'example.com',
            },
          ],
        },
      ],
    },
  };

  const result = searchTimeline(snapshot, 'GITHUB issue', { limit: 200 });

  assert.equal(result.active, true);
  assert.deepEqual(result.tokens, ['github', 'issue']);
  assert.equal(result.tabTree.length, 1);
  assert.equal(result.tabTree[0].searchMatch.isContext, true);
  assert.equal(result.tabTree[0].children.length, 1);
  assert.equal(result.tabTree[0].children[0].id, 2);
  assert.equal(result.tabTree[0].children[0].searchMatch.isMatch, true);
  assert.deepEqual(result.sessions.blocks.map(block => block.id), ['session-one']);
  assert.deepEqual(result.sessions.blocks[0].records.map(record => record.title), [
    'Issue 42 discussion',
  ]);
  assert.deepEqual(result.stats, {
    totalMatches: 2,
    displayedMatches: 2,
    hiddenMatches: 0,
    tabMatches: 1,
    historyMatches: 1,
    matchingSessions: 1,
  });
});

test('pagination counts real matches without charging for context ancestors', () => {
  const matchingTab = (id, title) => ({
    id,
    source: 'tab',
    title,
    url: `https://example.com/${id}/needle`,
    hostname: 'example.com',
    children: [],
  });
  const snapshot = {
    tabs: [],
    tabTree: [
      {
        id: 1,
        source: 'tab',
        title: 'Parent context',
        url: 'https://parent.example/start',
        hostname: 'parent.example',
        children: [matchingTab(2, 'Needle one'), matchingTab(3, 'Needle two')],
      },
    ],
    sessions: {
      blocks: [
        {
          id: 'session-one',
          records: [
            { title: 'Needle three', url: 'https://history.example/3', hostname: 'history.example' },
            { title: 'Needle four', url: 'https://history.example/4', hostname: 'history.example' },
          ],
        },
      ],
    },
  };

  const result = searchTimeline(snapshot, 'needle', { limit: 2 });

  assert.equal(result.tabTree.length, 1);
  assert.equal(result.tabTree[0].searchMatch.isContext, true);
  assert.deepEqual(result.tabTree[0].children.map(child => child.id), [2, 3]);
  assert.equal(result.sessions.blocks.length, 0);
  assert.deepEqual(result.stats, {
    totalMatches: 4,
    displayedMatches: 2,
    hiddenMatches: 2,
    tabMatches: 2,
    historyMatches: 2,
    matchingSessions: 1,
  });
});

test('URL-only matches include a readable clue while visible-field matches do not', () => {
  const snapshot = {
    tabs: [],
    tabTree: [],
    sessions: {
      blocks: [
        {
          id: 'session-one',
          records: [
            {
              title: 'Quarterly planning',
              url: 'https://example.com/projects/needle-board?view=all',
              hostname: 'example.com',
            },
            {
              title: 'Needle guide',
              url: 'https://docs.example.com/guide',
              hostname: 'docs.example.com',
            },
          ],
        },
      ],
    },
  };

  const result = searchTimeline(snapshot, 'needle', { limit: 200 });
  const [urlMatch, titleMatch] = result.sessions.blocks[0].records;

  assert.deepEqual(urlMatch.searchMatch.matchedFields, ['url']);
  assert.match(urlMatch.searchMatch.urlHint, /projects\/needle-board/);
  assert.deepEqual(titleMatch.searchMatch.matchedFields, ['title']);
  assert.equal(titleMatch.searchMatch.urlHint, '');
});

test('a query with no matches returns empty structures and zeroed statistics', () => {
  const snapshot = {
    tabs: [],
    tabTree: [
      {
        id: 1,
        title: 'Planning notes',
        url: 'https://example.com/planning',
        hostname: 'example.com',
        children: [],
      },
    ],
    sessions: {
      blocks: [
        {
          id: 'session-one',
          records: [
            {
              title: 'Release notes',
              url: 'https://example.com/releases',
              hostname: 'example.com',
            },
          ],
        },
      ],
    },
  };

  const result = searchTimeline(snapshot, 'does-not-exist', { limit: 200 });

  assert.deepEqual(result.tabTree, []);
  assert.deepEqual(result.sessions.blocks, []);
  assert.deepEqual(result.stats, {
    totalMatches: 0,
    displayedMatches: 0,
    hiddenMatches: 0,
    tabMatches: 0,
    historyMatches: 0,
    matchingSessions: 0,
  });
});
