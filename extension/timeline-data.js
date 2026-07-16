/* ================================================================
   Tab Out — Timeline Data Module

   Local-only data access for timeline experiments. This module reads
   Chrome history and open tabs, removes browser-internal URLs, and
   optionally marks records that match a caller-provided domain blacklist.
   ================================================================ */

'use strict';

const TIMELINE_HISTORY_MAX_RESULTS = 1000;
const TIMELINE_DEFAULT_HOURS = 48;
const TIMELINE_DEFAULT_SESSION_GAP_MINUTES = 30;
const INTERNAL_URL_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'edge://',
  'about:',
  'brave://',
  'opera://',
  'vivaldi://',
  'devtools://',
  'view-source:',
];

function isInternalTimelineUrl(url) {
  const normalized = String(url || '').trim().toLowerCase();
  return !normalized || INTERNAL_URL_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function getTimelineHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return ''; }
}

function normalizeBlacklist(blacklist) {
  if (!Array.isArray(blacklist)) return [];
  return blacklist
    .map(value => String(value || '').trim().toLowerCase().replace(/^www\./, ''))
    .filter(Boolean);
}

function findBlacklistMatch(url, blacklist) {
  const hostname = getTimelineHostname(url);
  if (!hostname) return null;
  return blacklist.find(domain => hostname === domain || hostname.endsWith(`.${domain}`)) || null;
}

/**
 * Fetches recent local browser history.
 * @param {number} hours Number of hours to look back. Defaults to 48.
 * @returns {Promise<Array<object>>}
 */
async function fetchRecentHistory(hours = TIMELINE_DEFAULT_HOURS) {
  const parsedHours = Number(hours);
  const safeHours = Number.isFinite(parsedHours) && parsedHours > 0
    ? parsedHours
    : TIMELINE_DEFAULT_HOURS;
  const startTime = Date.now() - safeHours * 60 * 60 * 1000;

  const items = await chrome.history.search({
    text: '',
    startTime,
    maxResults: TIMELINE_HISTORY_MAX_RESULTS,
  });

  return items.map(item => ({
    source: 'history',
    id: item.id || null,
    url: item.url || '',
    title: item.title || item.url || 'Untitled page',
    lastVisitTime: item.lastVisitTime || null,
    visitCount: item.visitCount || 0,
    typedCount: item.typedCount || 0,
  }));
}

/**
 * Fetches all currently open tabs across every Chrome window.
 * openerTabId is preserved for later parent/child timeline reconstruction.
 * @returns {Promise<Array<object>>}
 */
async function fetchCurrentTabs() {
  const tabs = await chrome.tabs.query({});
  return tabs.map(tab => ({
    source: 'tab',
    id: tab.id ?? null,
    url: tab.url || '',
    title: tab.title || tab.url || 'Untitled tab',
    favIconUrl: tab.favIconUrl || '',
    openerTabId: tab.openerTabId ?? null,
    windowId: tab.windowId ?? null,
    index: tab.index ?? null,
    active: Boolean(tab.active),
  }));
}

/**
 * Removes browser-internal pages and marks optional blacklist matches.
 * Blacklisted records remain in the output so a later UI can collapse,
 * de-emphasize, or hide them without discarding their timeline context.
 *
 * @param {{history?: Array<object>, tabs?: Array<object>}} data
 * @param {string[]} blacklist Domain names such as youtube.com.
 * @returns {{history: Array<object>, tabs: Array<object>, blacklisted: object, stats: object}}
 */
function cleanTimelineData(data, blacklist = []) {
  const input = data && typeof data === 'object' ? data : {};
  const history = Array.isArray(input.history) ? input.history : [];
  const tabs = Array.isArray(input.tabs) ? input.tabs : [];
  const normalizedBlacklist = normalizeBlacklist(blacklist);

  const cleanRecords = records => records
    .filter(record => record && !isInternalTimelineUrl(record.url))
    .map(record => {
      const blacklistDomain = findBlacklistMatch(record.url, normalizedBlacklist);
      return {
        ...record,
        hostname: getTimelineHostname(record.url),
        isBlacklisted: Boolean(blacklistDomain),
        blacklistDomain,
      };
    });

  const cleanHistory = cleanRecords(history);
  const cleanTabs = cleanRecords(tabs);
  const blacklistedHistory = cleanHistory.filter(record => record.isBlacklisted);
  const blacklistedTabs = cleanTabs.filter(record => record.isBlacklisted);

  return {
    history: cleanHistory,
    tabs: cleanTabs,
    blacklisted: {
      history: blacklistedHistory,
      tabs: blacklistedTabs,
    },
    stats: {
      inputHistory: history.length,
      inputTabs: tabs.length,
      cleanHistory: cleanHistory.length,
      cleanTabs: cleanTabs.length,
      filteredInternalHistory: history.length - cleanHistory.length,
      filteredInternalTabs: tabs.length - cleanTabs.length,
      blacklistedHistory: blacklistedHistory.length,
      blacklistedTabs: blacklistedTabs.length,
      historyMaxResults: TIMELINE_HISTORY_MAX_RESULTS,
    },
  };
}

/**
 * Groups history records into time-based browsing sessions.
 * Records are sorted newest-first. A new block begins only when the gap
 * between adjacent records is greater than the configured threshold.
 *
 * @param {Array<object>} records History records with lastVisitTime values.
 * @param {number} gapMinutes Maximum adjacent gap within one session.
 * @returns {{blocks: Array<object>, stats: object}}
 */
function clusterHistoryIntoSessions(
  records,
  gapMinutes = TIMELINE_DEFAULT_SESSION_GAP_MINUTES,
) {
  const input = Array.isArray(records) ? records : [];
  const parsedGap = Number(gapMinutes);
  const safeGapMinutes = Number.isFinite(parsedGap) && parsedGap > 0
    ? parsedGap
    : TIMELINE_DEFAULT_SESSION_GAP_MINUTES;
  const gapMs = safeGapMinutes * 60 * 1000;

  const sortedRecords = input
    .map(record => ({
      record,
      timestamp: Number(record?.lastVisitTime),
    }))
    .filter(item => Number.isFinite(item.timestamp) && item.timestamp > 0)
    .sort((a, b) => b.timestamp - a.timestamp);

  const blocks = [];
  let currentBlock = null;

  for (const item of sortedRecords) {
    const shouldStartNewBlock = !currentBlock ||
      currentBlock.earliestTimestamp - item.timestamp > gapMs;

    if (shouldStartNewBlock) {
      currentBlock = {
        id: `session-${Math.trunc(item.timestamp)}-${blocks.length + 1}`,
        startTime: item.timestamp,
        endTime: item.timestamp,
        earliestTimestamp: item.timestamp,
        latestTimestamp: item.timestamp,
        durationMs: 0,
        durationMinutes: 0,
        recordCount: 0,
        records: [],
      };
      blocks.push(currentBlock);
    }

    currentBlock.records.push(item.record);
    currentBlock.recordCount = currentBlock.records.length;
    currentBlock.earliestTimestamp = item.timestamp;
    currentBlock.startTime = item.timestamp;
    currentBlock.durationMs = currentBlock.latestTimestamp - currentBlock.earliestTimestamp;
    currentBlock.durationMinutes = Math.round(currentBlock.durationMs / 60000);
  }

  return {
    blocks,
    stats: {
      inputRecords: input.length,
      clusteredRecords: sortedRecords.length,
      skippedInvalidTimestamps: input.length - sortedRecords.length,
      sessionCount: blocks.length,
      gapMinutes: safeGapMinutes,
    },
  };
}

function getTabTreeKey(id) {
  if (id === null || id === undefined || id === '') return null;
  return String(id);
}

function wouldCreateTabCycle(childKey, parentKey, nodeMap) {
  const visited = new Set([childKey]);
  let currentKey = parentKey;

  while (currentKey !== null) {
    if (visited.has(currentKey)) return true;
    visited.add(currentKey);
    const currentNode = nodeMap.get(currentKey);
    if (!currentNode) return false;
    currentKey = getTabTreeKey(currentNode.openerTabId);
  }

  return false;
}

/**
 * Builds a forest of currently open tabs using openerTabId relationships.
 * Tabs whose opener is unavailable become roots. Duplicate IDs, self-links,
 * and cyclic opener chains are handled without mutating the input array.
 *
 * @param {Array<object>} tabs Current tabs returned by fetchCurrentTabs().
 * @returns {Array<object>} Root nodes with nested children arrays.
 */
function buildTabTree(tabs) {
  const input = Array.isArray(tabs) ? tabs : [];
  const nodeMap = new Map();
  const orderedNodes = [];

  for (const tab of input) {
    const key = getTabTreeKey(tab?.id);
    if (!key || nodeMap.has(key)) continue;

    const node = {
      ...tab,
      children: [],
    };
    nodeMap.set(key, node);
    orderedNodes.push({ key, node });
  }

  const childKeys = new Set();
  for (const { key, node } of orderedNodes) {
    const parentKey = getTabTreeKey(node.openerTabId);
    const parentNode = parentKey ? nodeMap.get(parentKey) : null;

    if (!parentNode) {
      if (parentKey) node.orphanedOpener = true;
      continue;
    }

    if (wouldCreateTabCycle(key, parentKey, nodeMap)) {
      node.cyclePrevented = true;
      continue;
    }
    parentNode.children.push(node);
    childKeys.add(key);
  }

  return orderedNodes
    .filter(({ key }) => !childKeys.has(key))
    .map(({ node }) => node);
}

function countTabTreeNodes(roots) {
  let count = 0;
  const stack = Array.isArray(roots) ? [...roots] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    count += 1;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return count;
}

async function fetchTimelineSnapshot(options = {}) {
  const hours = options.hours ?? TIMELINE_DEFAULT_HOURS;
  const blacklist = options.blacklist ?? [];
  const sessionGapMinutes = options.sessionGapMinutes ?? TIMELINE_DEFAULT_SESSION_GAP_MINUTES;
  const [history, tabs] = await Promise.all([
    Array.isArray(options.history) ? options.history : fetchRecentHistory(hours),
    Array.isArray(options.tabs) ? options.tabs : fetchCurrentTabs(),
  ]);
  const raw = { history, tabs };
  const cleaned = cleanTimelineData(raw, blacklist);
  const sessions = clusterHistoryIntoSessions(cleaned.history, sessionGapMinutes);
  const tabTree = buildTabTree(cleaned.tabs);
  const summary = {
    ...cleaned.stats,
    sessionCount: sessions.blocks.length,
    tabTreeRoots: tabTree.length,
    tabTreeNodes: countTabTreeNodes(tabTree),
  };
  return { ...cleaned, sessions, tabTree, summary, raw };
}

async function runTimelineDataDebug(options = {}) {
  const result = await fetchTimelineSnapshot(options);

  console.log('[Tab Out Timeline] raw data', result.raw);
  console.log('[Tab Out Timeline] cleaned data', { history: result.history, tabs: result.tabs });
  console.log('[Tab Out Timeline] session blocks', result.sessions);
  console.log('[Tab Out Timeline] tab tree', result.tabTree);
  console.log('[Tab Out Timeline] summary', result.summary);
  return result;
}

globalThis.TabOutTimeline = Object.freeze({
  fetchRecentHistory,
  fetchCurrentTabs,
  cleanTimelineData,
  clusterHistoryIntoSessions,
  buildTabTree,
  fetchTimelineSnapshot,
  runTimelineDataDebug,
  constants: Object.freeze({
    defaultHours: TIMELINE_DEFAULT_HOURS,
    historyMaxResults: TIMELINE_HISTORY_MAX_RESULTS,
    defaultSessionGapMinutes: TIMELINE_DEFAULT_SESSION_GAP_MINUTES,
  }),
});
