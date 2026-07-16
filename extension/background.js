/**
 * Tab Out background service worker.
 *
 * Owns persistent data, timeline aggregation, website classification,
 * analytics calculations, and the incrementally maintained toolbar badge.
 */

'use strict';

importScripts(
  'config.local.js',
  'constants/siteCategories.js',
  'storage/indexedDb.js',
  'storage/categoryCache.js',
  'services/categoryService.js',
  'services/analyticsService.js',
  'timeline-data.js',
);

const WORKER_CHANNEL = 'tab-out-worker';
const trackedTabs = new Map();
const pendingTabMutations = [];
let tabStateInitialized = false;
let tabStateInitializationPromise = null;

function normalizeTrackedTab(tab, existing = {}) {
  return {
    ...existing,
    id: tab?.id ?? existing.id,
    url: tab?.url ?? existing.url ?? '',
    title: tab?.title ?? existing.title ?? '',
    favIconUrl: tab?.favIconUrl ?? existing.favIconUrl ?? '',
    openerTabId: tab?.openerTabId ?? existing.openerTabId ?? null,
    windowId: tab?.windowId ?? existing.windowId ?? null,
    index: tab?.index ?? existing.index ?? null,
    active: tab?.active ?? existing.active ?? false,
    pinned: tab?.pinned ?? existing.pinned ?? false,
  };
}

function isRealWebTab(tab) {
  const url = String(tab?.url || '');
  return (
    !url.startsWith('chrome://') &&
    !url.startsWith('chrome-extension://') &&
    !url.startsWith('about:') &&
    !url.startsWith('edge://') &&
    !url.startsWith('brave://')
  );
}

async function renderBadge() {
  const count = [...trackedTabs.values()].filter(isRealWebTab).length;
  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  if (count === 0) return;

  const color = count <= 10
    ? '#3d7a4a'
    : count <= 20
      ? '#b8892e'
      : '#b35a5a';
  await chrome.action.setBadgeBackgroundColor({ color });
}

function applyTabMutation(mutation) {
  if (mutation.type === 'remove') {
    const previous = trackedTabs.get(mutation.tabId);
    trackedTabs.delete(mutation.tabId);
    return Boolean(previous && isRealWebTab(previous));
  }

  const previous = trackedTabs.get(mutation.tab.id);
  const next = normalizeTrackedTab(mutation.tab, previous || {});
  trackedTabs.set(next.id, next);
  return isRealWebTab(previous) !== isRealWebTab(next);
}

function applyOrQueueTabMutation(mutation) {
  if (!tabStateInitialized) {
    pendingTabMutations.push(mutation);
    return false;
  }
  return applyTabMutation(mutation);
}

function renderBadgeSafely() {
  renderBadge().catch(() => chrome.action.setBadgeText({ text: '' }));
}

async function initializeTabState(force = false) {
  if (tabStateInitializationPromise) return tabStateInitializationPromise;
  if (tabStateInitialized && !force) return undefined;

  tabStateInitialized = false;
  tabStateInitializationPromise = (async () => {
    try {
      const tabs = await chrome.tabs.query({});
      trackedTabs.clear();
      tabs.forEach(tab => trackedTabs.set(tab.id, normalizeTrackedTab(tab)));
      tabStateInitialized = true;
      pendingTabMutations.splice(0).forEach(applyTabMutation);
      await renderBadge();
    } catch {
      tabStateInitialized = true;
      pendingTabMutations.splice(0).forEach(applyTabMutation);
      await chrome.action.setBadgeText({ text: '' });
    } finally {
      tabStateInitializationPromise = null;
    }
  })();
  return tabStateInitializationPromise;
}

function getTrackedTabs() {
  return [...trackedTabs.values()];
}

async function getTimelineSnapshot(options = {}) {
  await initializeTabState();
  try {
    const snapshot = await globalThis.TabOutTimeline.fetchTimelineSnapshot({
      ...options,
      tabs: getTrackedTabs(),
    });
    const capturedAt = Date.now();
    await globalThis.TabOutDatabase.replaceSessions(snapshot.sessions.blocks, capturedAt);
    return { ...snapshot, persistedAt: capturedAt, fromCache: false };
  } catch (error) {
    const cachedBlocks = await globalThis.TabOutDatabase.getSessions();
    if (cachedBlocks.length === 0) throw error;

    const cleaned = globalThis.TabOutTimeline.cleanTimelineData({
      history: cachedBlocks.flatMap(block => block.records || []),
      tabs: getTrackedTabs(),
    }, options.blacklist || []);
    const tabTree = globalThis.TabOutTimeline.buildTabTree(cleaned.tabs);
    return {
      ...cleaned,
      sessions: {
        blocks: cachedBlocks,
        stats: {
          inputRecords: cleaned.history.length,
          clusteredRecords: cleaned.history.length,
          skippedInvalidTimestamps: 0,
          sessionCount: cachedBlocks.length,
          gapMinutes: options.sessionGapMinutes || 30,
        },
      },
      tabTree,
      summary: {
        ...cleaned.stats,
        sessionCount: cachedBlocks.length,
        tabTreeRoots: tabTree.length,
      },
      persistedAt: Math.max(...cachedBlocks.map(block => Number(block.capturedAt || 0))),
      fromCache: true,
    };
  }
}

async function handleWorkerRequest(type, payload = {}) {
  if (type === 'categories:get') {
    const hostnames = Array.isArray(payload.hostnames) ? payload.hostnames.slice(0, 500) : [];
    const categories = await globalThis.TabOutCategoryService.getCategories(hostnames);
    return { categories: Object.fromEntries(categories) };
  }

  if (type === 'categories:clear') {
    return { cleared: await globalThis.TabOutCategoryService.clearCache() };
  }

  if (type === 'timeline:get') return getTimelineSnapshot(payload);

  if (type === 'sessions:get') {
    return { sessions: await globalThis.TabOutDatabase.getSessions() };
  }

  if (type === 'analytics:get') {
    await initializeTabState();
    return globalThis.TabOutAnalyticsService.getDashboard(getTrackedTabs());
  }

  if (type === 'analytics:recordClosed') {
    await globalThis.TabOutAnalyticsService.recordTabsClosed(payload.count, payload.source);
    await initializeTabState();
    return globalThis.TabOutAnalyticsService.getDashboard(getTrackedTabs());
  }

  throw new Error(`Unknown worker request: ${type}`);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.channel !== WORKER_CHANNEL) return false;

  handleWorkerRequest(message.type, message.payload)
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => {
      console.warn(`[tab-out] Worker request failed: ${message.type}`, error);
      sendResponse({ ok: false, error: error?.message || 'Unknown worker error' });
    });
  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  initializeTabState(true);
});

chrome.runtime.onStartup.addListener(() => {
  initializeTabState(true);
});

chrome.tabs.onCreated.addListener(tab => {
  if (applyOrQueueTabMutation({ type: 'upsert', tab })) renderBadgeSafely();
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (applyOrQueueTabMutation({ type: 'remove', tabId })) renderBadgeSafely();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const nextTab = { ...tab, ...changeInfo, id: tabId };
  if (applyOrQueueTabMutation({ type: 'upsert', tab: nextTab })) renderBadgeSafely();
});

chrome.tabs.onActivated.addListener(activeInfo => {
  trackedTabs.forEach(tab => {
    if (tab.windowId === activeInfo.windowId) tab.active = tab.id === activeInfo.tabId;
  });
});

initializeTabState();
