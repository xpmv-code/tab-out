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
  'services/cloudSync.js',
);

const WORKER_CHANNEL = 'tab-out-worker';
const trackedTabs = new Map();
const pendingTabMutations = [];
let tabStateInitialized = false;
let tabStateInitializationPromise = null;

const TAB_OUT_SYNC_RETRY_ALARM = 'tab-out-cloud-sync-retry';
const TAB_OUT_SYNC_POLL_ALARM = 'tab-out-cloud-sync-poll';
const TAB_OUT_SYNC_SESSION_KEY = 'tabOutSyncSession';
const TAB_OUT_SYNC_PENDING_KEY = 'tabOutSyncPending';

function getTabOutSyncOriginPattern() {
  const rawUrl = globalThis.TAB_OUT_SYNC_CONFIG?.supabaseUrl;
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)) return '';
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return '';
    return parsed.origin + '/*';
  } catch {
    return '';
  }
}

async function clearTabOutSyncAlarms() {
  await chrome.alarms.clear(TAB_OUT_SYNC_RETRY_ALARM);
  await chrome.alarms.clear(TAB_OUT_SYNC_POLL_ALARM);
}

async function ensureTabOutSyncAlarms() {
  if (!globalThis.TabOutCloudSync?.isConfigured()) {
    await clearTabOutSyncAlarms();
    return;
  }

  const state = await chrome.storage.local.get([
    TAB_OUT_SYNC_SESSION_KEY,
    TAB_OUT_SYNC_PENDING_KEY,
  ]);
  const session = state[TAB_OUT_SYNC_SESSION_KEY];
  if (!session?.userId || !session?.accessToken) {
    await clearTabOutSyncAlarms();
    return;
  }

  const originPattern = getTabOutSyncOriginPattern();
  if (!originPattern || !(await chrome.permissions.contains({ origins: [originPattern] }))) {
    await clearTabOutSyncAlarms();
    return;
  }

  // Poll while Chrome is running so remote changes are applied even if no Tab Out
  // page is open. Pending writes get an additional early retry after worker wake-up.
  chrome.alarms.create(TAB_OUT_SYNC_POLL_ALARM, { periodInMinutes: 5 });
  const pending = state[TAB_OUT_SYNC_PENDING_KEY];
  if (pending && pending.ownerId === session.userId) {
    chrome.alarms.create(TAB_OUT_SYNC_RETRY_ALARM, { delayInMinutes: 0.5 });
  } else {
    await chrome.alarms.clear(TAB_OUT_SYNC_RETRY_ALARM);
  }
}

async function runTabOutSyncAlarm() {
  if (!globalThis.TabOutCloudSync?.isConfigured()) return;
  const state = await chrome.storage.local.get(TAB_OUT_SYNC_SESSION_KEY);
  const session = state[TAB_OUT_SYNC_SESSION_KEY];
  if (!session?.userId || !session?.accessToken) return;

  const originPattern = getTabOutSyncOriginPattern();
  if (!originPattern || !(await chrome.permissions.contains({ origins: [originPattern] }))) return;

  try {
    await globalThis.TabOutCloudSync.syncNow({ requestPermission: false });
    const latest = await chrome.storage.local.get([
      TAB_OUT_SYNC_SESSION_KEY,
      TAB_OUT_SYNC_PENDING_KEY,
    ]);
    const activeSession = latest[TAB_OUT_SYNC_SESSION_KEY];
    const pending = latest[TAB_OUT_SYNC_PENDING_KEY];
    if (
      activeSession?.userId === session.userId &&
      (!pending || pending.ownerId !== session.userId)
    ) {
      await chrome.alarms.clear(TAB_OUT_SYNC_RETRY_ALARM);
    }
  } catch (error) {
    console.warn('[tab-out] Background cloud sync failed; a retry will be scheduled.', error);
  }
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== TAB_OUT_SYNC_RETRY_ALARM && alarm.name !== TAB_OUT_SYNC_POLL_ALARM) return;
  runTabOutSyncAlarm().catch(error => {
    console.warn('[tab-out] Could not run background cloud sync:', error);
  });
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  if (changes[TAB_OUT_SYNC_SESSION_KEY]) {
    ensureTabOutSyncAlarms().then(() => {
      const session = changes[TAB_OUT_SYNC_SESSION_KEY].newValue;
      if (session?.userId && session?.accessToken) {
        chrome.alarms.create(TAB_OUT_SYNC_RETRY_ALARM, { delayInMinutes: 0.5 });
      }
    }).catch(error => {
      console.warn('[tab-out] Could not update cloud sync alarms:', error);
    });
  }

  const pending = changes[TAB_OUT_SYNC_PENDING_KEY]?.newValue;
  if (pending) {
    chrome.alarms.create(TAB_OUT_SYNC_RETRY_ALARM, { delayInMinutes: 0.5 });
  }
});

chrome.permissions.onAdded.addListener(() => {
  ensureTabOutSyncAlarms().catch(error => {
    console.warn('[tab-out] Could not arm cloud sync after permissions changed:', error);
  });
});

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
  ensureTabOutSyncAlarms().catch(error => {
    console.warn('[tab-out] Could not initialize cloud sync alarms:', error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  initializeTabState(true);
  ensureTabOutSyncAlarms().catch(error => {
    console.warn('[tab-out] Could not restore cloud sync alarms:', error);
  });
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

ensureTabOutSyncAlarms().catch(error => {
  console.warn('[tab-out] Could not inspect cloud sync state:', error);
});

initializeTabState();
