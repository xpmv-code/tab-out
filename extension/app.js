/* ================================================================
   Tab Out — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — queried once, then maintained by Chrome tab events.
let openTabs = [];
let openTabsInitialized = false;
const pendingOpenTabMutations = [];

function getTabOutUrl() {
  return `chrome-extension://${chrome.runtime.id}/index.html`;
}

function normalizeOpenTab(tab, existing = {}) {
  const url = tab?.url ?? existing.url ?? '';
  return {
    ...existing,
    id: tab?.id ?? existing.id,
    url,
    title: tab?.title ?? existing.title ?? '',
    favIconUrl: tab?.favIconUrl ?? existing.favIconUrl ?? '',
    windowId: tab?.windowId ?? existing.windowId,
    index: tab?.index ?? existing.index ?? 0,
    active: tab?.active ?? existing.active ?? false,
    pinned: tab?.pinned ?? existing.pinned ?? false,
    openerTabId: tab?.openerTabId ?? existing.openerTabId,
    isTabOut: url === getTabOutUrl() || url === 'chrome://newtab/',
  };
}

function insertOpenTabByPosition(tab) {
  let insertAt = openTabs.length;
  let lastSameWindowIndex = -1;
  for (let index = 0; index < openTabs.length; index += 1) {
    const current = openTabs[index];
    if (current.windowId !== tab.windowId) continue;
    lastSameWindowIndex = index;
    if ((current.index ?? 0) > (tab.index ?? 0)) {
      insertAt = index;
      break;
    }
  }
  if (insertAt === openTabs.length && lastSameWindowIndex >= 0) insertAt = lastSameWindowIndex + 1;
  openTabs.splice(insertAt, 0, tab);
}

function shiftOpenTabIndexesForInsert(tab) {
  openTabs.forEach(item => {
    if (item.windowId === tab.windowId && (item.index ?? 0) >= (tab.index ?? 0)) {
      item.index = (item.index ?? 0) + 1;
    }
  });
}

function shiftOpenTabIndexesForRemoval(tab) {
  openTabs.forEach(item => {
    if (item.windowId === tab.windowId && (item.index ?? 0) > (tab.index ?? 0)) {
      item.index = Math.max(0, (item.index ?? 0) - 1);
    }
  });
}

function upsertOpenTab(tab) {
  if (!Number.isFinite(Number(tab?.id))) return false;
  const existingIndex = openTabs.findIndex(item => item.id === tab.id);
  const existing = existingIndex >= 0 ? openTabs[existingIndex] : null;
  const normalized = normalizeOpenTab(tab, existing || {});
  const relevantKeys = ['url', 'title', 'favIconUrl', 'windowId', 'index', 'active', 'pinned', 'openerTabId', 'isTabOut'];
  const changed = !existing || relevantKeys.some(key => existing[key] !== normalized[key]);
  if (!changed) return false;

  if (existingIndex >= 0) {
    openTabs.splice(existingIndex, 1);
    if (existing.windowId !== normalized.windowId || existing.index !== normalized.index) {
      shiftOpenTabIndexesForRemoval(existing);
      shiftOpenTabIndexesForInsert(normalized);
    }
  } else {
    shiftOpenTabIndexesForInsert(normalized);
  }
  if (normalized.active) {
    openTabs.forEach(item => {
      if (item.windowId === normalized.windowId) item.active = false;
    });
  }
  insertOpenTabByPosition(normalized);
  return true;
}

function removeOpenTabsByIds(tabIds) {
  const ids = new Set((Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number));
  let changed = false;
  ids.forEach(id => {
    const index = openTabs.findIndex(tab => Number(tab.id) === id);
    if (index === -1) return;
    const [removed] = openTabs.splice(index, 1);
    shiftOpenTabIndexesForRemoval(removed);
    changed = true;
  });
  return changed;
}

function updateActiveOpenTab(tabId, windowId) {
  let changed = false;
  openTabs.forEach(tab => {
    if (tab.windowId !== windowId) return;
    const active = tab.id === tabId;
    if (tab.active !== active) {
      tab.active = active;
      changed = true;
    }
  });
  return changed;
}

function applyOpenTabMutation(mutation) {
  if (mutation.type === 'upsert') return upsertOpenTab(mutation.tab);
  if (mutation.type === 'remove') return removeOpenTabsByIds(mutation.tabId);
  if (mutation.type === 'activate') return updateActiveOpenTab(mutation.tabId, mutation.windowId);
  return false;
}

function applyOrQueueOpenTabMutation(mutation) {
  if (!openTabsInitialized) {
    pendingOpenTabMutations.push(mutation);
    return false;
  }
  return applyOpenTabMutation(mutation);
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(tab => normalizeOpenTab(tab));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  } finally {
    openTabsInitialized = true;
    pendingOpenTabMutations.splice(0).forEach(applyOpenTabMutation);
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * The in-memory tab list is updated optimistically and by onRemoved.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return 0;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const toClose = openTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await removeTabsWithAnalytics(toClose, 'close-domain');
  return toClose.length;
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return 0;
  const urlSet = new Set(urls);
  const toClose = openTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await removeTabsWithAnalytics(toClose, 'close-exact');
  return toClose.length;
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = openTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = openTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const toClose = [];

  for (const url of urls) {
    const matching = openTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await removeTabsWithAnalytics(toClose, 'close-duplicates');
  return toClose.length;
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = openTabs.filter(tab => tab.isTabOut);

  if (tabOutTabs.length <= 1) return 0;

  // Keep the active Tab Out tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await removeTabsWithAnalytics(toClose, 'close-tabout-extras');
  return toClose.length;
}


/* ----------------------------------------------------------------
   TAB ANALYTICS — local cleanup achievements
   ---------------------------------------------------------------- */

async function recordTabsClosed(count, source = 'cleanup') {
  const safeCount = Math.max(0, Math.trunc(Number(count) || 0));
  if (safeCount === 0) return;

  try {
    const dashboard = await globalThis.TabOutBackgroundClient?.recordTabsClosed(safeCount, source);
    await renderTabAnalytics(dashboard);
  } catch (error) {
    console.warn('[tab-out] Could not persist cleanup analytics:', error);
  }
}

async function removeTabsWithAnalytics(tabIds, source) {
  const uniqueIds = [...new Set((Array.isArray(tabIds) ? tabIds : [tabIds])
    .map(id => Number(id))
    .filter(Number.isFinite))];
  if (uniqueIds.length === 0) return 0;

  await chrome.tabs.remove(uniqueIds);
  if (removeOpenTabsByIds(uniqueIds)) scheduleIncrementalDashboardRender(280);
  await recordTabsClosed(uniqueIds.length, source);
  return uniqueIds.length;
}

function formatEstimatedMemory(memoryMb) {
  if (memoryMb >= 1024) {
    const gigabytes = memoryMb / 1024;
    return `${gigabytes >= 10 ? Math.round(gigabytes) : gigabytes.toFixed(1)} GB`;
  }
  return `${Math.round(memoryMb)} MB`;
}

let analyticsRenderVersion = 0;
async function renderTabAnalytics(prefetchedDashboard = null) {
  const board = document.getElementById('analyticsBoard');
  if (!board) return;
  const renderVersion = ++analyticsRenderVersion;

  let dashboard = prefetchedDashboard;
  try {
    if (!dashboard) dashboard = await globalThis.TabOutBackgroundClient?.getAnalyticsDashboard();
  } catch (error) {
    console.warn('[tab-out] Could not load analytics dashboard:', error);
    return;
  }
  if (!dashboard) return;
  if (renderVersion !== analyticsRenderVersion) return;
  const { analytics, duplicateStats, today } = dashboard;

  document.getElementById('analyticsClosedTabs').textContent = today.closedTabs;
  document.getElementById('analyticsMemory').textContent = formatEstimatedMemory(today.estimatedMemoryMb);
  document.getElementById('analyticsDuplicateRate').textContent = `${duplicateStats.duplicateRate}%`;
  document.getElementById('analyticsDuplicateDetail').textContent = `${duplicateStats.duplicateExtras} 个重复项`;
  document.getElementById('analyticsDuplicateBar').style.width = `${Math.min(100, duplicateStats.duplicateRate)}%`;
  document.getElementById('analyticsDate').textContent = new Date().toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });

  const pressureHigh = duplicateStats.tabCount > analytics.settings.warningThreshold;
  const warning = document.getElementById('tabPressureWarning');
  const message = document.getElementById('tabPressureMessage');
  document.body.classList.toggle('tab-pressure-high', pressureHigh);
  if (warning) warning.hidden = !pressureHigh;
  if (message && pressureHigh) {
    message.textContent = `已经打开 ${duplicateStats.tabCount} 个标签页，电脑快喘不过气了，来清理一批吧。`;
  }
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   QUICK LINKS — chrome.storage.local

   User-managed favorite sites rendered below the header.
   Data shape stored under the "quickLinkData" key:
   { schemaVersion, groups: [{ id, name, createdAt }], links: [{ ..., groupId }] }
   ---------------------------------------------------------------- */

const QUICK_LINK_DATA_KEY = 'quickLinkData';
const QUICK_LINK_SCHEMA_VERSION = 3;
const QUICK_LINK_ACTIVE_GROUP_KEY = 'quickLinkActiveGroupId';
const QUICK_LINK_ALL_GROUP_ID = globalThis.TabOutFavoritesRenderer?.ALL_GROUP_ID || '__all__';
let activeQuickLinkGroupId = QUICK_LINK_ALL_GROUP_ID;
let quickLinkGroupPreferenceLoaded = false;
let quickLinkDragState = null;
let quickLinkLookup = new Map();
let quickLinkPickerState = null;
let favoriteSuggestionRequest = null;
let toastActionHandler = null;
let toastHideTimer = null;

function createQuickLinkId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createQuickLinkGroup(name = '常用') {
  return {
    id: createQuickLinkId('group'),
    name: String(name || '').trim().slice(0, 30) || '未命名分组',
    createdAt: new Date().toISOString(),
  };
}

function getLocalFaviconUrl(pageUrl, size = 32) {
  if (!pageUrl) return '';
  try {
    const faviconUrl = new URL(chrome.runtime.getURL('_favicon/'));
    faviconUrl.searchParams.set('pageUrl', pageUrl);
    faviconUrl.searchParams.set('size', String(Math.max(16, Math.min(Number(size) || 32, 64))));
    return faviconUrl.toString();
  } catch {
    return '';
  }
}

function normalizeQuickLinkUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function isSupportedQuickLinkUrl(rawUrl) {
  try {
    return ['http:', 'https:'].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

function getQuickLinkUrlKey(rawUrl) {
  const normalized = normalizeQuickLinkUrl(rawUrl);
  if (!isSupportedQuickLinkUrl(normalized)) return '';

  const parsed = new URL(normalized);
  parsed.hash = '';
  return parsed.href;
}

function updateQuickLinkLookup(data) {
  const groups = new Map(data.groups.map(group => [group.id, group]));
  quickLinkLookup = new Map();
  data.links.forEach(link => {
    const key = getQuickLinkUrlKey(link.url);
    if (!key || quickLinkLookup.has(key)) return;
    quickLinkLookup.set(key, { link, group: groups.get(link.groupId) || data.groups[0] });
  });
}

function findQuickLinkByUrl(data, rawUrl) {
  const key = getQuickLinkUrlKey(rawUrl);
  if (!key) return null;
  const link = data.links.find(item => getQuickLinkUrlKey(item.url) === key);
  if (!link) return null;
  return {
    link,
    group: data.groups.find(group => group.id === link.groupId) || data.groups[0],
  };
}

function getQuickLinkTitle(url, title = '') {
  const cleanTitleValue = String(title || '').trim();
  if (cleanTitleValue) return cleanTitleValue;

  const hostname = getTabHostname(url).replace(/^www\./, '');
  return friendlyDomain(hostname) || hostname || '链接';
}

function getQuickLinkInitial(title) {
  const clean = String(title || '').trim();
  const match = clean.match(/[A-Za-z0-9\u4e00-\u9fff]/);
  return match ? match[0].toUpperCase() : '链';
}

function getQuickLinkFaviconUrl(url) {
  return getLocalFaviconUrl(url, 64);
}

function normalizeQuickLinkData(rawData, legacyLinks = []) {
  const rawGroups = Array.isArray(rawData?.groups) ? rawData.groups.slice(0, 100) : [];
  const seenGroupIds = new Set();
  const groups = rawGroups
    .filter(group => group && (group.id || group.name))
    .map(group => {
      let id = String(group.id || createQuickLinkId('group'));
      if (seenGroupIds.has(id)) id = createQuickLinkId('group');
      seenGroupIds.add(id);
      return {
        id,
        name: String(group.name || '').trim().slice(0, 30) || '未命名分组',
        createdAt: group.createdAt || new Date().toISOString(),
      };
    });

  if (groups.length === 0) groups.push(createQuickLinkGroup('常用'));
  const groupIds = new Set(groups.map(group => group.id));
  const groupsById = new Map(groups.map(group => [group.id, group]));
  const defaultGroupId = groups[0].id;
  const sourceLinks = (Array.isArray(rawData?.links) ? rawData.links : legacyLinks).slice(0, 2000);
  const seenIds = new Set();
  const seenUrlKeys = new Set();
  const links = sourceLinks
    .filter(link => link && link.url)
    .map(link => {
      const url = normalizeQuickLinkUrl(link.url);
      if (!isSupportedQuickLinkUrl(url)) return null;
      const urlKey = getQuickLinkUrlKey(url);
      if (!urlKey || seenUrlKeys.has(urlKey)) return null;
      seenUrlKeys.add(urlKey);
      let id = String(link.id || createQuickLinkId('link'));
      if (seenIds.has(id)) id = createQuickLinkId('link');
      seenIds.add(id);
      const normalizedLink = {
        id,
        url,
        title: getQuickLinkTitle(url, link.title),
        groupId: groupIds.has(link.groupId) ? link.groupId : defaultGroupId,
        createdAt: link.createdAt || new Date().toISOString(),
        description: link.description || '',
        favicon: link.favicon || '',
        category: link.category || '',
        badge: link.badge || '',
        color: link.color || '',
        metadataSource: link.metadataSource || '',
        suggestedCategory: link.suggestedCategory || '',
        suggestionStatus: link.suggestionStatus || '',
        suggestionCheckedAt: link.suggestionCheckedAt || '',
      };
      const groupName = groupsById.get(normalizedLink.groupId)?.name || groups[0].name;
      return globalThis.TabOutFavoritesMetadata?.enrichFavorite(normalizedLink, groupName) || normalizedLink;
    })
    .filter(Boolean);

  return {
    schemaVersion: QUICK_LINK_SCHEMA_VERSION,
    groups,
    links,
  };
}

async function saveQuickLinkData(data) {
  const normalized = normalizeQuickLinkData(data);
  await chrome.storage.local.set({ [QUICK_LINK_DATA_KEY]: normalized });
  updateQuickLinkLookup(normalized);
  return normalized;
}

async function getQuickLinkData() {
  const stored = await chrome.storage.local.get([QUICK_LINK_DATA_KEY, 'quickLinks']);
  const rawData = stored[QUICK_LINK_DATA_KEY];
  const legacyLinks = Array.isArray(stored.quickLinks) ? stored.quickLinks : [];
  const normalized = normalizeQuickLinkData(rawData, legacyLinks);

  if (!rawData || JSON.stringify(rawData) !== JSON.stringify(normalized)) {
    await chrome.storage.local.set({ [QUICK_LINK_DATA_KEY]: normalized });
  }
  updateQuickLinkLookup(normalized);
  return normalized;
}

function downloadJsonFile(payload, filename) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const downloadUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = downloadUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000);
}

async function exportQuickLinks() {
  const quickLinks = await getQuickLinkData();
  downloadJsonFile({
    app: 'Tab Out',
    type: 'quick-links',
    version: QUICK_LINK_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    quickLinks,
  }, `tab-out-quick-links-${new Date().toISOString().slice(0, 10)}.json`);
  return quickLinks.links.length;
}

async function importQuickLinks(file) {
  if (!file || file.size > 2 * 1024 * 1024) throw new Error('Invalid quick link file size');
  const parsed = JSON.parse(await file.text());
  const rawData = parsed?.quickLinks || parsed;
  if (!Array.isArray(rawData?.groups) || !Array.isArray(rawData?.links)) {
    throw new Error('Invalid quick link file');
  }

  const imported = normalizeQuickLinkData(rawData);
  const existing = await getQuickLinkData();
  const existingGroupIds = new Set(existing.groups.map(group => group.id));
  const existingGroupNames = new Map(existing.groups.map(group => [group.name.toLowerCase(), group]));
  const groupIdMap = new Map();
  let groupsAdded = 0;

  imported.groups.forEach(group => {
    const sameNameGroup = existingGroupNames.get(group.name.toLowerCase());
    if (sameNameGroup) {
      groupIdMap.set(group.id, sameNameGroup.id);
      return;
    }

    const id = existingGroupIds.has(group.id) ? createQuickLinkId('group') : group.id;
    const nextGroup = { ...group, id };
    existing.groups.push(nextGroup);
    existingGroupIds.add(id);
    existingGroupNames.set(nextGroup.name.toLowerCase(), nextGroup);
    groupIdMap.set(group.id, id);
    groupsAdded += 1;
  });

  const existingLinkIds = new Set(existing.links.map(link => link.id));
  const existingUrls = new Set(existing.links.map(link => getQuickLinkUrlKey(link.url)).filter(Boolean));
  let linksAdded = 0;
  let linksSkipped = 0;

  imported.links.forEach(link => {
    const urlKey = getQuickLinkUrlKey(link.url);
    if (!urlKey || existingUrls.has(urlKey)) {
      linksSkipped += 1;
      return;
    }

    const id = existingLinkIds.has(link.id) ? createQuickLinkId('link') : link.id;
    existing.links.push({
      ...link,
      id,
      groupId: groupIdMap.get(link.groupId) || existing.groups[0].id,
    });
    existingLinkIds.add(id);
    existingUrls.add(urlKey);
    linksAdded += 1;
  });

  await saveQuickLinkData(existing);
  return { groupsAdded, linksAdded, linksSkipped };
}

async function addQuickLink(rawUrl, rawTitle = '', groupId = activeQuickLinkGroupId, details = {}) {
  const url = normalizeQuickLinkUrl(rawUrl);
  if (!url) throw new Error('Missing URL');

  let parsed;
  try { parsed = new URL(url); }
  catch { throw new Error('Invalid URL'); }

  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error('Only web links are supported');
  }

  const data = await getQuickLinkData();
  const targetGroupId = data.groups.some(group => group.id === groupId)
    ? groupId
    : data.groups[0].id;
  const targetGroup = data.groups.find(group => group.id === targetGroupId) || data.groups[0];
  const title = getQuickLinkTitle(url, rawTitle);
  const existing = findQuickLinkByUrl(data, url);

  if (existing) {
    return { status: 'duplicate', ...existing };
  }

  const baseLink = {
    id: createQuickLinkId('link'),
    url,
    title,
    groupId: targetGroupId,
    createdAt: new Date().toISOString(),
    description: details.description || '',
    favicon: details.favicon || '',
    badge: details.badge || '',
    color: details.color || '',
    metadataSource: details.metadataSource || '',
  };
  const link = globalThis.TabOutFavoritesMetadata?.enrichFavorite(baseLink, targetGroup.name) || baseLink;
  data.links.push(link);
  await saveQuickLinkData(data);
  return {
    status: 'added',
    link,
    group: data.groups.find(group => group.id === targetGroupId) || data.groups[0],
  };
}

async function removeQuickLink(id) {
  const data = await getQuickLinkData();
  const removed = data.links.find(link => link.id === id) || null;
  data.links = data.links.filter(link => link.id !== id);
  await saveQuickLinkData(data);
  return removed;
}

async function restoreQuickLink(link) {
  if (!link) return false;
  const data = await getQuickLinkData();
  if (findQuickLinkByUrl(data, link.url)) return false;
  const targetGroupId = data.groups.some(group => group.id === link.groupId)
    ? link.groupId
    : data.groups[0].id;
  data.links.push({ ...link, groupId: targetGroupId });
  await saveQuickLinkData(data);
  return true;
}

async function updateQuickLink(id, changes) {
  const data = await getQuickLinkData();
  const link = data.links.find(item => item.id === id);
  if (!link) throw new Error('Favorite not found');

  const url = normalizeQuickLinkUrl(changes.url || link.url);
  if (!isSupportedQuickLinkUrl(url)) throw new Error('Invalid URL');
  const urlKey = getQuickLinkUrlKey(url);
  const duplicate = data.links.find(item => item.id !== id && getQuickLinkUrlKey(item.url) === urlKey);
  if (duplicate) {
    return {
      status: 'duplicate',
      link: duplicate,
      group: data.groups.find(group => group.id === duplicate.groupId) || data.groups[0],
    };
  }

  const targetGroup = data.groups.find(group => group.id === changes.groupId)
    || data.groups.find(group => group.id === link.groupId)
    || data.groups[0];
  const updated = globalThis.TabOutFavoritesMetadata?.enrichFavorite({
    ...link,
    url,
    title: getQuickLinkTitle(url, changes.title),
    groupId: targetGroup.id,
    description: changes.description || '',
    badge: changes.badge || '',
    color: changes.color || '',
    metadataSource: 'custom',
    suggestionStatus: 'dismissed',
    suggestedCategory: '',
  }, targetGroup.name) || link;
  Object.assign(link, updated);
  await saveQuickLinkData(data);
  return { status: 'updated', link, group: targetGroup };
}

async function addQuickLinkGroup(name) {
  const data = await getQuickLinkData();
  const normalizedName = String(name || '').trim();
  if (!normalizedName) throw new Error('Missing group name');
  if (data.groups.some(group => group.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error('Duplicate group name');
  }
  const group = createQuickLinkGroup(normalizedName);
  data.groups.push(group);
  await saveQuickLinkData(data);
  return group;
}

async function renameQuickLinkGroup(groupId, name) {
  const data = await getQuickLinkData();
  const group = data.groups.find(item => item.id === groupId);
  const normalizedName = String(name || '').trim().slice(0, 30);
  if (!group || !normalizedName) throw new Error('Invalid group');
  if (data.groups.some(item => item.id !== groupId && item.name.toLowerCase() === normalizedName.toLowerCase())) {
    throw new Error('Duplicate group name');
  }
  group.name = normalizedName;
  data.links.forEach(link => {
    if (link.groupId !== groupId) return;
    link.category = normalizedName;
  });
  await saveQuickLinkData(data);
  return group;
}

async function deleteQuickLinkGroup(groupId) {
  const data = await getQuickLinkData();
  if (data.groups.length <= 1) throw new Error('At least one group is required');
  const groupIndex = data.groups.findIndex(group => group.id === groupId);
  if (groupIndex === -1) throw new Error('Group not found');

  const fallbackGroup = data.groups.find(group => group.id !== groupId);
  data.groups.splice(groupIndex, 1);
  data.links.forEach(link => {
    if (link.groupId !== groupId) return;
    link.groupId = fallbackGroup.id;
    link.category = fallbackGroup.name;
    link.suggestionStatus = 'dismissed';
  });
  await saveQuickLinkData(data);
  return fallbackGroup;
}

async function moveQuickLink(linkId, targetGroupId, targetLinkId = null, position = 'before') {
  const data = await getQuickLinkData();
  const link = data.links.find(item => item.id === linkId);
  if (!link || !data.groups.some(group => group.id === targetGroupId)) return;
  if (targetLinkId === linkId) return;

  const groupChanged = link.groupId !== targetGroupId;
  data.links = data.links.filter(item => item.id !== linkId);
  link.groupId = targetGroupId;
  const targetGroup = data.groups.find(group => group.id === targetGroupId);
  link.category = targetGroup?.name || link.category;
  if (groupChanged) {
    link.suggestionStatus = 'dismissed';
    link.suggestedCategory = '';
  }
  const targetIndex = targetLinkId
    ? data.links.findIndex(item => item.id === targetLinkId && item.groupId === targetGroupId)
    : -1;

  if (targetIndex >= 0) {
    data.links.splice(targetIndex + (position === 'after' ? 1 : 0), 0, link);
  } else {
    const lastGroupIndex = data.links.reduce((last, item, index) => (
      item.groupId === targetGroupId ? index : last
    ), -1);
    data.links.splice(lastGroupIndex + 1, 0, link);
  }
  await saveQuickLinkData(data);
}

async function moveQuickLinkGroup(groupId, targetGroupId, position = 'before') {
  if (!groupId || !targetGroupId || groupId === targetGroupId) return;
  const data = await getQuickLinkData();
  const group = data.groups.find(item => item.id === groupId);
  if (!group) return;

  data.groups = data.groups.filter(item => item.id !== groupId);
  const targetIndex = data.groups.findIndex(item => item.id === targetGroupId);
  if (targetIndex === -1) return;
  data.groups.splice(targetIndex + (position === 'after' ? 1 : 0), 0, group);
  await saveQuickLinkData(data);
}

async function openQuickLink(url) {
  const normalized = normalizeQuickLinkUrl(url);
  if (!normalized) return;

  try {
    const currentTab = await chrome.tabs.getCurrent();
    if (currentTab?.id) {
      await chrome.tabs.update(currentTab.id, { url: normalized });
      return;
    }
  } catch {}

  await chrome.tabs.create({ url: normalized });
}


/* ----------------------------------------------------------------
   WORKSPACES — saved window snapshots

   Data shape stored under the "workspaces" key:
   [{ id, name, createdAt, updatedAt, tabs: [{ url, title }] }]
   ---------------------------------------------------------------- */

const WORKSPACE_SCHEMA_VERSION = 1;

function createLocalId(prefix) {
  if (globalThis.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isRestorableWorkspaceUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return ['http:', 'https:', 'file:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function normalizeWorkspaceTab(tab) {
  if (!tab || !isRestorableWorkspaceUrl(tab.url)) return null;
  return {
    url: tab.url,
    title: String(tab.title || getReadableUrl(tab.url) || tab.url).trim(),
  };
}

function normalizeWorkspaceDate(value, fallback) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function normalizeWorkspace(workspace) {
  if (!workspace || !Array.isArray(workspace.tabs)) return null;

  const tabs = workspace.tabs.map(normalizeWorkspaceTab).filter(Boolean);
  if (tabs.length === 0) return null;

  const now = new Date().toISOString();
  const createdAt = normalizeWorkspaceDate(workspace.createdAt, now);
  return {
    id: String(workspace.id || createLocalId('workspace')),
    name: String(workspace.name || '未命名工作空间').trim().slice(0, 80) || '未命名工作空间',
    createdAt,
    updatedAt: normalizeWorkspaceDate(workspace.updatedAt, createdAt),
    tabs,
  };
}

async function getWorkspaces() {
  const { workspaces } = await chrome.storage.local.get('workspaces');
  const stored = Array.isArray(workspaces) ? workspaces : [];
  return stored
    .map(normalizeWorkspace)
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

async function setWorkspaces(workspaces) {
  await chrome.storage.local.set({ workspaces });
}

async function createWorkspaceFromCurrentWindow(name) {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const snapshotTabs = tabs.map(normalizeWorkspaceTab).filter(Boolean);
  if (snapshotTabs.length === 0) throw new Error('No restorable tabs in this window');

  const now = new Date().toISOString();
  const workspace = {
    id: createLocalId('workspace'),
    name: String(name || '').trim().slice(0, 80) || `工作空间 ${new Date().toLocaleDateString('zh-CN')}`,
    createdAt: now,
    updatedAt: now,
    tabs: snapshotTabs,
  };
  const workspaces = await getWorkspaces();
  await setWorkspaces([workspace, ...workspaces]);
  return workspace;
}

async function updateWorkspace(id, changes) {
  const workspaces = await getWorkspaces();
  const workspace = workspaces.find(item => item.id === id);
  if (!workspace) throw new Error('Workspace not found');

  if (typeof changes.name === 'string') {
    workspace.name = changes.name.trim().slice(0, 80) || workspace.name;
  }
  if (Array.isArray(changes.tabs)) {
    const tabs = changes.tabs.map(normalizeWorkspaceTab).filter(Boolean);
    if (tabs.length > 0) workspace.tabs = tabs;
  }
  workspace.updatedAt = new Date().toISOString();
  await setWorkspaces(workspaces);
  return workspace;
}

async function deleteWorkspace(id) {
  const workspaces = await getWorkspaces();
  await setWorkspaces(workspaces.filter(workspace => workspace.id !== id));
}

async function restoreWorkspace(id, mode) {
  const workspaces = await getWorkspaces();
  const workspace = workspaces.find(item => item.id === id);
  if (!workspace) throw new Error('Workspace not found');

  const urls = workspace.tabs.map(tab => tab.url).filter(isRestorableWorkspaceUrl);
  if (urls.length === 0) throw new Error('Workspace has no restorable tabs');

  if (mode === 'merge') {
    const currentWindow = await chrome.windows.getCurrent();
    const createdTabs = [];
    for (const url of urls) {
      createdTabs.push(await chrome.tabs.create({ windowId: currentWindow.id, url, active: false }));
    }
    if (createdTabs[0]?.id) await chrome.tabs.update(createdTabs[0].id, { active: true });
  } else {
    await chrome.windows.create({ url: urls, focused: true });
  }

  await updateWorkspace(id, {});
  return workspace;
}

async function exportWorkspaces() {
  const workspaces = await getWorkspaces();
  if (workspaces.length === 0) throw new Error('No workspaces to export');

  const payload = {
    app: 'Tab Out',
    version: WORKSPACE_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    workspaces,
  };
  downloadJsonFile(payload, `tab-out-workspaces-${new Date().toISOString().slice(0, 10)}.json`);
}

async function importWorkspaces(file) {
  const parsed = JSON.parse(await file.text());
  const importedItems = Array.isArray(parsed) ? parsed : parsed?.workspaces;
  if (!Array.isArray(importedItems)) throw new Error('Invalid workspace file');

  const imported = importedItems.map(normalizeWorkspace).filter(Boolean);
  if (imported.length === 0) throw new Error('No valid workspaces found');

  const existing = await getWorkspaces();
  const byId = new Map(existing.map(workspace => [workspace.id, workspace]));
  for (const workspace of imported) byId.set(workspace.id, workspace);
  await setWorkspaces([...byId.values()]);
  return imported.length;
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const theme = getComputedStyle(document.documentElement);
  const colorNames = [
    '--accent-amber',
    '--status-cooling',
    '--accent-sage',
    '--status-active',
    '--accent-slate',
    '--muted',
    '--warm-gray',
    '--accent-rose',
  ];
  const colors = colorNames.map(name => theme.getPropertyValue(name).trim()).filter(Boolean);
  if (colors.length === 0) colors.push('#c8713a', '#5a7a62', '#5a6b7a', '#b35a5a');

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message, action = null) {
  const toast = document.getElementById('toast');
  const text = document.getElementById('toastText');
  const actionButton = document.getElementById('toastAction');
  if (!toast || !text) return;

  clearTimeout(toastHideTimer);
  text.textContent = message;
  toastActionHandler = typeof action?.handler === 'function' ? action.handler : null;
  if (actionButton) {
    actionButton.hidden = !toastActionHandler;
    actionButton.textContent = toastActionHandler ? action.label : '';
  }
  toast.classList.add('visible');
  toastHideTimer = setTimeout(() => {
    toast.classList.remove('visible');
    toastActionHandler = null;
    if (actionButton) actionButton.hidden = true;
  }, toastActionHandler ? 5000 : 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">标签页清空了</div>
      <div class="empty-subtitle">现在轻松多了。</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 个域名';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return '刚刚';
  if (diffMins < 60)  return `${diffMins} 分钟前`;
  if (diffHours < 24) return `${diffHours} 小时前`;
  if (diffDays === 1) return '昨天';
  return `${diffDays} 天前`;
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 6) return '夜深了';
  if (hour < 12) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('zh-CN', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          '本地文件',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + ' 的 Substack';
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `@${username} 的帖子` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} 议题 #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} 合并请求 #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube 视频';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} 帖子`;
    }
  }

  return title || url;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function getTabHostname(url) {
  if (!url) return '';
  if (url.startsWith('file://')) return 'local-files';
  try { return new URL(url).hostname; }
  catch { return ''; }
}

function getReadableUrl(url) {
  if (!url) return '';
  if (url.startsWith('file://')) return url.replace(/^file:\/\//, '本地文件 ');
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const path = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
    return path && path !== '/' ? `${host}${path}` : host;
  } catch {
    return url;
  }
}

function getTabDisplayTitle(tab, groupDomain = '') {
  let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), groupDomain);
  try {
    const parsed = new URL(tab.url);
    if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
  } catch {}
  return label || tab.url || '未命名标签页';
}

function getOpenTabSearchQuery() {
  return openTabSearchQuery.trim().toLowerCase();
}

function tabMatchesSearch(tab, group, query) {
  if (!query) return true;
  const hostname = getTabHostname(tab.url);
  const titleDomain = group.typeCategory ? hostname : group.domain;
  const haystack = [
    tab.title,
    getTabDisplayTitle(tab, titleDomain),
    tab.url,
    hostname,
    hostname.replace(/^www\./, ''),
    friendlyDomain(hostname),
    group.label,
    group.typeCategory,
    group.domain === '__landing-pages__' ? 'homepages' : '',
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(query);
}

function filterDomainGroupsForSearch(groups, query) {
  if (!query) return groups;

  return groups.map(group => {
    const groupLabel = group.domain === '__landing-pages__'
      ? '首页'
      : (group.label || friendlyDomain(group.domain));
    const groupHaystack = [
      groupLabel,
      group.label,
      group.domain,
      group.domain === '__landing-pages__' ? 'homepages landing inbox' : '',
    ].filter(Boolean).join(' ').toLowerCase();

    if (groupHaystack.includes(query)) return { ...group };

    const tabs = group.tabs.filter(tab => tabMatchesSearch(tab, group, query));
    return tabs.length > 0 ? { ...group, tabs } : null;
  }).filter(Boolean);
}

function decodeUrlList(encodedList) {
  if (!encodedList) return [];
  return encodedList.split(',')
    .map(value => {
      try { return decodeURIComponent(value); }
      catch { return ''; }
    })
    .filter(Boolean);
}

function isSameLocalDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

function formatTimelineDay(date) {
  const today = new Date();
  if (isSameLocalDay(date, today)) return '今天';

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (isSameLocalDay(date, yesterday)) return '昨天';

  return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

function formatTimelineClock(timestamp) {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatTimelineRange(block) {
  const start = new Date(block.startTime);
  const end = new Date(block.endTime);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return '时间未知';

  if (isSameLocalDay(start, end)) {
    return `${formatTimelineDay(end)}, ${formatTimelineClock(start)} - ${formatTimelineClock(end)}`;
  }

  return `${formatTimelineDay(start)}, ${formatTimelineClock(start)} - ${formatTimelineDay(end)}, ${formatTimelineClock(end)}`;
}

function getTimelineNodeInitial(record) {
  const value = String(record.title || record.hostname || '页面').trim();
  const match = value.match(/[A-Za-z0-9\u4e00-\u9fff]/);
  return match ? match[0].toUpperCase() : '页';
}

function getTimelineNodeFavicon(record) {
  return getLocalFaviconUrl(record.url, 32);
}

function getOpenTabByUrlMap(tabs) {
  const map = new Map();
  for (const tab of tabs || []) {
    if (!tab.url) continue;
    const existing = map.get(tab.url);
    if (!existing || tab.active) map.set(tab.url, tab);
  }
  return map;
}

function renderTimelineNode(record, currentTab = null) {
  const activeTab = currentTab || (record.source === 'tab' ? record : null);
  const hostname = record.hostname || getTabHostname(record.url).replace(/^www\./, '');
  const faviconUrl = getTimelineNodeFavicon({ ...record, favIconUrl: activeTab?.favIconUrl || record.favIconUrl });
  const safeUrl = escapeAttr(record.url || '');
  const safeTitle = escapeAttr(record.title || record.url || '未命名页面');
  const tabId = activeTab?.id ?? '';
  const windowId = activeTab?.windowId ?? '';
  const visitTime = record.lastVisitTime ? formatTimelineClock(record.lastVisitTime) : '';

  return `
    <button class="timeline-node-card${activeTab ? ' current-tab' : ''}${record.orphanedOpener || record.cyclePrevented ? ' orphan-root' : ''}" data-action="open-timeline-node" data-tab-id="${escapeAttr(tabId)}" data-window-id="${escapeAttr(windowId)}" data-node-url="${safeUrl}" title="${safeTitle}">
      ${faviconUrl
        ? `<img class="timeline-node-favicon" src="${escapeAttr(faviconUrl)}" data-fallback="${escapeAttr(getTimelineNodeInitial(record))}" alt="">`
        : `<span class="timeline-node-fallback">${escapeHtml(getTimelineNodeInitial(record))}</span>`}
      <span class="timeline-node-content">
        <span class="timeline-node-title">${escapeHtml(record.title || record.url || '未命名页面')}</span>
        <span class="timeline-node-meta">
          <span class="timeline-node-domain">${escapeHtml(hostname || getReadableUrl(record.url))}</span>
          ${visitTime ? `<span class="timeline-node-time">${escapeHtml(visitTime)}</span>` : ''}
        </span>
      </span>
      <span class="timeline-node-status">${record.orphanedOpener || record.cyclePrevented ? '根节点' : (activeTab ? '已打开' : '历史记录')}</span>
    </button>`;
}

function countTimelineTreeNodes(nodes) {
  let count = 0;
  const stack = Array.isArray(nodes) ? [...nodes] : [];
  while (stack.length > 0) {
    const node = stack.pop();
    count += 1;
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return count;
}

function renderTimelineTree(nodes, renderState) {
  let html = '';
  for (const node of nodes || []) {
    if (renderState.processed >= renderState.limit) {
      const hiddenSubtreeCount = countTimelineTreeNodes([node]);
      renderState.processed += hiddenSubtreeCount;
      renderState.hidden += hiddenSubtreeCount;
      continue;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    renderState.processed += 1;
    renderState.rendered += 1;
    html += `
      <div class="timeline-tree-branch">
        ${renderTimelineNode(node, node)}
        ${children.length > 0 ? `<div class="timeline-tree-children">${renderTimelineTree(children, renderState)}</div>` : ''}
      </div>`;
  }
  return html;
}

function renderTimelineSessionBlock(block, openTabMap, renderState) {
  const availableSlots = Math.max(0, renderState.limit - renderState.processed);
  const visibleCount = Math.min(block.records.length, availableSlots);
  const visibleRecords = block.records.slice(0, visibleCount);
  renderState.processed += block.records.length;
  renderState.rendered += visibleRecords.length;
  const hiddenCount = block.records.length - visibleRecords.length;
  renderState.hidden += hiddenCount;
  const nodes = visibleRecords.map(record =>
    renderTimelineNode(record, openTabMap.get(record.url) || null)
  ).join('');

  return `
    <section class="timeline-block" data-session-id="${escapeAttr(block.id)}">
      <div class="timeline-block-header">
        <div class="timeline-block-time">${escapeHtml(formatTimelineRange(block))}</div>
        <div class="timeline-block-count">${block.recordCount} 个页面</div>
      </div>
      <div class="timeline-node-list">${nodes}</div>
      ${hiddenCount > 0
        ? `<button class="timeline-expand-btn" data-action="expand-timeline-session" data-session-id="${escapeAttr(block.id)}" data-required-limit="${renderState.processed}">再显示 ${hiddenCount} 项</button>`
        : ''}
    </section>`;
}

function paintTimelineSnapshot(snapshot) {
  const container = document.getElementById('timelineContainer');
  const empty = document.getElementById('timelineEmpty');
  const summary = document.getElementById('timelineSummary');
  if (!container || !snapshot) return;

  const openTabMap = getOpenTabByUrlMap(snapshot.tabs);
  const blocks = [];
  const renderState = {
    limit: timelineNodeLimit,
    processed: 0,
    rendered: 0,
    hidden: 0,
  };

  if (snapshot.tabTree.length > 0) {
    const openTree = renderTimelineTree(snapshot.tabTree, renderState);
    blocks.push(`
      <section class="timeline-block open-now">
        <div class="timeline-block-header">
          <div class="timeline-block-time">当前打开</div>
          <div class="timeline-block-count">${snapshot.tabs.length} 个标签页</div>
        </div>
        <div class="timeline-tree-root">${openTree}</div>
      </section>`);
  }

  for (const block of snapshot.sessions.blocks) {
    blocks.push(renderTimelineSessionBlock(block, openTabMap, renderState));
  }

  if (renderState.hidden > 0) {
    blocks.push(`<button class="timeline-load-more" data-action="load-more-timeline">加载更多（剩余 ${renderState.hidden} 项）</button>`);
  }

  container.innerHTML = blocks.join('');
  if (empty) empty.hidden = blocks.length > 0;
  if (summary) {
    const totalNodes = countTimelineTreeNodes(snapshot.tabTree) + snapshot.sessions.blocks.reduce((sum, block) => sum + block.records.length, 0);
    summary.textContent = `${snapshot.tabs.length} 个已打开标签页 · ${snapshot.sessions.blocks.length} 个会话 · 已显示 ${renderState.rendered}/${totalNodes} 个节点`;
  }
}

function setTimelineBackToTopVisible(visible) {
  const button = document.getElementById('timelineBackToTop');
  timelineBackToTopVisible = Boolean(visible);
  if (!button) return;

  button.classList.toggle('is-visible', timelineBackToTopVisible);
  button.setAttribute('aria-hidden', String(!timelineBackToTopVisible));
  button.tabIndex = timelineBackToTopVisible ? 0 : -1;
}

function syncTimelineBackToTopVisibility() {
  const timeline = document.getElementById('timelineView');
  const timelineActive = activeAppView === 'timeline' && timeline && !timeline.hidden;
  const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
  const threshold = timelineBackToTopVisible
    ? TIMELINE_BACK_TO_TOP_HIDE_AT
    : TIMELINE_BACK_TO_TOP_SHOW_AT;

  setTimelineBackToTopVisible(Boolean(timelineActive && scrollTop > threshold));
}

function scheduleTimelineBackToTopSync() {
  if (timelineBackToTopFrame !== null) return;
  timelineBackToTopFrame = requestAnimationFrame(() => {
    timelineBackToTopFrame = null;
    syncTimelineBackToTopVisibility();
  });
}

function scrollTimelineToTop() {
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({
    top: 0,
    behavior: reduceMotion ? 'auto' : 'smooth',
  });
}

async function renderTimelineView(force = false) {
  const refreshButton = document.querySelector('[data-action="refresh-timeline"]');
  const summary = document.getElementById('timelineSummary');

  if (timelineSnapshot && !force) {
    paintTimelineSnapshot(timelineSnapshot);
    return;
  }

  if (!globalThis.TabOutBackgroundClient?.getTimelineSnapshot) {
    if (summary) summary.textContent = '后台时间线服务不可用。';
    return;
  }

  refreshButton?.classList.add('loading');
  if (refreshButton) refreshButton.disabled = true;
  if (summary) summary.textContent = '正在加载最近活动...';
  timelineNodeLimit = TIMELINE_NODE_PAGE_SIZE;

  try {
    timelineSnapshot = await globalThis.TabOutBackgroundClient.getTimelineSnapshot({
      hours: 48,
      sessionGapMinutes: 30,
    });
    paintTimelineSnapshot(timelineSnapshot);
  } catch (err) {
    console.warn('[tab-out] Timeline rendering failed:', err);
    if (summary) summary.textContent = '无法加载最近活动。';
    showToast('无法加载时间线');
  } finally {
    refreshButton?.classList.remove('loading');
    if (refreshButton) refreshButton.disabled = false;
  }
}

async function setAppView(view) {
  const nextView = view === 'timeline' ? 'timeline' : 'dashboard';
  activeAppView = nextView;

  document.getElementById('dashboardView').hidden = nextView !== 'dashboard';
  document.getElementById('timelineView').hidden = nextView !== 'timeline';
  syncTimelineBackToTopVisibility();
  const groupByControl = document.getElementById('groupByControl');
  if (groupByControl) groupByControl.hidden = nextView !== 'dashboard';
  document.querySelectorAll('.view-switch-btn').forEach(button => {
    const active = button.dataset.view === nextView;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });

  if (nextView === 'timeline') {
    await renderTimelineView(false);
  } else {
    await renderDashboard({ refreshTabs: false, renderAuxiliary: false });
  }
}

async function activateTimelineNode(tabId, url) {
  if (tabId !== null && tabId !== undefined && tabId !== '') {
    try {
      const tab = await chrome.tabs.get(Number(tabId));
      await chrome.tabs.highlight({ windowId: tab.windowId, tabs: tab.index });
      await chrome.windows.update(tab.windowId, { focused: true });
      return;
    } catch {
      // The tab may have closed after the timeline snapshot was created.
    }
  }

  if (url) await chrome.tabs.create({ url });
}

function invalidateTimelineSnapshot() {
  timelineSnapshot = null;
  if (activeAppView === 'timeline') {
    const summary = document.getElementById('timelineSummary');
    if (summary) summary.textContent = '浏览活动已变化，请刷新时间线。';
  }
}

let incrementalDashboardRenderTimer = null;
function scheduleIncrementalDashboardRender(delay = 80) {
  clearTimeout(incrementalDashboardRenderTimer);
  incrementalDashboardRenderTimer = setTimeout(() => {
    if (activeAppView !== 'dashboard') return;
    renderDashboard({ refreshTabs: false, renderAuxiliary: false }).catch(error => {
      console.warn('[tab-out] Incremental dashboard render failed:', error);
    });
  }, delay);
}

function handleTabCreated(tab) {
  if (applyOrQueueOpenTabMutation({ type: 'upsert', tab })) {
    invalidateTimelineSnapshot();
    scheduleIncrementalDashboardRender();
  }
}

function handleTabRemoved(tabId) {
  if (applyOrQueueOpenTabMutation({ type: 'remove', tabId })) {
    invalidateTimelineSnapshot();
    scheduleIncrementalDashboardRender(280);
  }
}

function handleTabUpdated(tabId, changeInfo, tab) {
  const nextTab = { ...tab, ...changeInfo, id: tabId };
  if (applyOrQueueOpenTabMutation({ type: 'upsert', tab: nextTab })) {
    invalidateTimelineSnapshot();
    scheduleIncrementalDashboardRender();
  }
}

function handleTabActivated(activeInfo) {
  if (applyOrQueueOpenTabMutation({
    type: 'activate',
    tabId: activeInfo.tabId,
    windowId: activeInfo.windowId,
  })) {
    scheduleIncrementalDashboardRender();
  }
}

try {
  chrome.tabs.onCreated.addListener(handleTabCreated);
  chrome.tabs.onRemoved.addListener(handleTabRemoved);
  chrome.tabs.onUpdated.addListener(handleTabUpdated);
  chrome.tabs.onActivated.addListener(handleTabActivated);
  chrome.history.onVisited.addListener(invalidateTimelineSnapshot);
  chrome.history.onVisitRemoved.addListener(invalidateTimelineSnapshot);
} catch {
  // Event APIs are unavailable outside an extension page.
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];
let groupedTabs = [];
let openTabSearchQuery = '';
let activeAppView = 'dashboard';
let activeGroupingMode = 'domain';
let dashboardRenderVersion = 0;
let timelineSnapshot = null;
const TIMELINE_NODE_PAGE_SIZE = 200;
let timelineNodeLimit = TIMELINE_NODE_PAGE_SIZE;
const TIMELINE_BACK_TO_TOP_SHOW_AT = 320;
const TIMELINE_BACK_TO_TOP_HIDE_AT = 120;
let timelineBackToTopVisible = false;
let timelineBackToTopFrame = null;


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

function syncGroupingModeControl() {
  document.querySelectorAll('.group-by-btn').forEach(button => {
    const active = button.dataset.groupMode === activeGroupingMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function getCategoryHostname(url) {
  const hostname = getTabHostname(url).replace(/^www\./, '');
  return hostname === 'local-files' ? '' : hostname;
}

async function buildTypeGroups(tabs) {
  const config = globalThis.TabOutSiteCategories || {};
  const categoryOrder = config.CATEGORIES || ['Other'];
  const categoryLabels = config.CATEGORY_LABELS || { Other: '其他' };
  const otherCategory = config.OTHER_CATEGORY || 'Other';
  const validCategories = new Set(categoryOrder);
  const hostnames = tabs.map(tab => getCategoryHostname(tab.url)).filter(Boolean);
  let categoriesByHostname = new Map();

  try {
    if (globalThis.TabOutBackgroundClient?.getCategories) {
      categoriesByHostname = await globalThis.TabOutBackgroundClient.getCategories(hostnames);
    }
  } catch (error) {
    console.warn('[tab-out] Type grouping fell back to Other:', error);
  }

  const buckets = new Map(categoryOrder.map(category => [category, []]));
  for (const tab of tabs) {
    const hostname = getCategoryHostname(tab.url);
    const resolved = hostname ? categoriesByHostname.get(hostname) : otherCategory;
    const category = validCategories.has(resolved) ? resolved : otherCategory;
    if (!buckets.has(category)) buckets.set(category, []);
    buckets.get(category).push(tab);
  }

  return categoryOrder
    .filter(category => (buckets.get(category) || []).length > 0)
    .map(category => ({
      domain: `__type-${category.toLowerCase().replace(/[^a-z0-9]+/g, '-')}__`,
      label: categoryLabels[category] || category,
      typeCategory: category,
      tabs: buckets.get(category),
    }));
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}

async function ensureActiveQuickLinkGroup(data) {
  if (!quickLinkGroupPreferenceLoaded) {
    const stored = await chrome.storage.local.get(QUICK_LINK_ACTIVE_GROUP_KEY);
    activeQuickLinkGroupId = stored[QUICK_LINK_ACTIVE_GROUP_KEY] || QUICK_LINK_ALL_GROUP_ID;
    quickLinkGroupPreferenceLoaded = true;
  }
  if (
    activeQuickLinkGroupId !== QUICK_LINK_ALL_GROUP_ID &&
    !data.groups.some(group => group.id === activeQuickLinkGroupId)
  ) {
    activeQuickLinkGroupId = QUICK_LINK_ALL_GROUP_ID;
    await chrome.storage.local.set({ [QUICK_LINK_ACTIVE_GROUP_KEY]: activeQuickLinkGroupId });
  }
}

async function renderQuickLinks({ classify = true } = {}) {
  const strip = document.getElementById('quickLinksStrip');
  const groupTabs = document.getElementById('quickLinkGroupTabs');
  const deleteGroupButton = document.getElementById('deleteQuickLinkGroupButton');
  const renameGroupButton = document.getElementById('renameQuickLinkGroupButton');
  if (!strip || !groupTabs) return;

  const data = await getQuickLinkData();
  await ensureActiveQuickLinkGroup(data);
  const renderer = globalThis.TabOutFavoritesRenderer;
  if (!renderer) return;

  groupTabs.innerHTML = renderer.renderGroupTabs(data, activeQuickLinkGroupId, { escapeAttr, escapeHtml });
  strip.innerHTML = renderer.renderFavorites(data, activeQuickLinkGroupId, {
    escapeAttr,
    escapeHtml,
    getFaviconUrl: getQuickLinkFaviconUrl,
    getInitial: getQuickLinkInitial,
  });
  renderer.applyCardColors(strip);

  const managingGroup = activeQuickLinkGroupId !== QUICK_LINK_ALL_GROUP_ID;
  if (deleteGroupButton) deleteGroupButton.disabled = !managingGroup || data.groups.length <= 1;
  if (renameGroupButton) renameGroupButton.disabled = !managingGroup;
  if (classify) queueFavoriteCategorySuggestions(data);
}

function getFavoriteHostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function queueFavoriteCategorySuggestions(snapshot) {
  if (favoriteSuggestionRequest || !globalThis.TabOutBackgroundClient?.getCategories) return;
  const pending = snapshot.links
    .filter(link => !link.suggestionStatus)
    .map(link => ({ id: link.id, hostname: getFavoriteHostname(link.url) }))
    .filter(item => item.hostname);
  if (pending.length === 0) return;

  let completed = false;
  favoriteSuggestionRequest = (async () => {
    const categories = await globalThis.TabOutBackgroundClient.getCategories(pending.map(item => item.hostname));
    const data = await getQuickLinkData();
    let changed = false;

    pending.forEach(item => {
      const link = data.links.find(candidate => candidate.id === item.id);
      if (!link || link.suggestionStatus) return;
      const group = data.groups.find(candidate => candidate.id === link.groupId) || data.groups[0];
      const serviceCategory = categories.get(item.hostname);
      const suggested = globalThis.TabOutFavoritesMetadata?.mapServiceCategory(serviceCategory) || '其他';
      link.suggestionCheckedAt = new Date().toISOString();
      if (suggested !== '其他' && suggested !== group.name) {
        link.suggestedCategory = suggested;
        link.suggestionStatus = 'available';
      } else {
        link.suggestedCategory = '';
        link.suggestionStatus = 'none';
      }
      changed = true;
    });

    if (changed) {
      await saveQuickLinkData(data);
      await renderQuickLinks({ classify: false });
    }
    completed = true;
  })()
    .catch(error => console.warn('[tab-out] Favorite classification suggestions failed:', error))
    .finally(() => {
      favoriteSuggestionRequest = null;
      if (!completed) return;

      setTimeout(async () => {
        try {
          const latest = await getQuickLinkData();
          if (latest.links.some(link => !link.suggestionStatus && getFavoriteHostname(link.url))) {
            queueFavoriteCategorySuggestions(latest);
          }
        } catch (error) {
          console.warn('[tab-out] Failed to check queued favorite suggestions:', error);
        }
      }, 0);
    });
}

async function acceptFavoriteSuggestion(linkId) {
  const data = await getQuickLinkData();
  const link = data.links.find(item => item.id === linkId);
  const category = link?.suggestedCategory;
  if (!link || !category) return null;

  let group = data.groups.find(item => item.name.toLowerCase() === category.toLowerCase());
  if (!group) {
    group = createQuickLinkGroup(category);
    data.groups.push(group);
  }
  link.groupId = group.id;
  link.category = group.name;
  link.suggestionStatus = 'accepted';
  link.suggestedCategory = '';
  await saveQuickLinkData(data);
  return group;
}

async function dismissFavoriteSuggestion(linkId) {
  const data = await getQuickLinkData();
  const link = data.links.find(item => item.id === linkId);
  if (!link) return false;
  link.suggestionStatus = 'dismissed';
  link.suggestedCategory = '';
  await saveQuickLinkData(data);
  return true;
}

async function refreshQuickLinkViews() {
  await renderQuickLinks();
  await renderDashboard({ refreshTabs: false, renderAuxiliary: false });
}

function getQuickLinkDuplicateMessage(match) {
  return `已存在于“${match?.group?.name || '常用'}”分组`;
}

function closeQuickLinkPicker() {
  const picker = document.getElementById('quickLinkPicker');
  if (picker) picker.hidden = true;
  quickLinkPickerState = null;
}

function positionQuickLinkPicker(anchor) {
  const picker = document.getElementById('quickLinkPicker');
  if (!picker || !anchor || picker.hidden) return;

  const anchorRect = anchor.getBoundingClientRect();
  const pickerRect = picker.getBoundingClientRect();
  const viewportPadding = 12;
  const gap = 6;
  const left = Math.min(
    window.innerWidth - pickerRect.width - viewportPadding,
    Math.max(viewportPadding, anchorRect.right - pickerRect.width)
  );
  const below = anchorRect.bottom + gap;
  const above = anchorRect.top - pickerRect.height - gap;
  const top = below + pickerRect.height <= window.innerHeight - viewportPadding
    ? below
    : Math.max(viewportPadding, above);

  picker.style.left = `${left}px`;
  picker.style.top = `${top}px`;
}

async function openQuickLinkPicker(anchor, rawUrl, rawTitle) {
  const data = await getQuickLinkData();
  const duplicate = findQuickLinkByUrl(data, rawUrl);
  if (duplicate) {
    closeQuickLinkPicker();
    showToast(getQuickLinkDuplicateMessage(duplicate));
    return;
  }

  const picker = document.getElementById('quickLinkPicker');
  const title = document.getElementById('quickLinkPickerTitle');
  const groupList = document.getElementById('quickLinkPickerGroups');
  const createForm = document.getElementById('quickLinkPickerGroupForm');
  const createInput = document.getElementById('quickLinkPickerGroupName');
  if (!picker || !groupList) return;

  const counts = new Map(data.groups.map(group => [group.id, 0]));
  data.links.forEach(link => counts.set(link.groupId, (counts.get(link.groupId) || 0) + 1));
  groupList.innerHTML = data.groups.map(group => `
    <button class="quick-link-picker-group" type="button" data-action="add-picker-tab-to-group" data-group-id="${escapeAttr(group.id)}">
      <span>${escapeHtml(group.name)}</span>
      <span class="quick-link-picker-count">${counts.get(group.id) || 0}</span>
    </button>`).join('');

  quickLinkPickerState = {
    url: normalizeQuickLinkUrl(rawUrl),
    title: getQuickLinkTitle(rawUrl, rawTitle),
    anchor,
  };
  if (title) title.textContent = quickLinkPickerState.title;
  if (createForm) createForm.hidden = true;
  if (createInput) createInput.value = '';
  picker.hidden = false;
  positionQuickLinkPicker(anchor);
}

async function addPickerTabToGroup(groupId) {
  if (!quickLinkPickerState) return;
  const { url, title } = quickLinkPickerState;
  const result = await addQuickLink(url, title, groupId);
  if (result.status === 'duplicate') {
    closeQuickLinkPicker();
    showToast(getQuickLinkDuplicateMessage(result));
    return;
  }

  activeQuickLinkGroupId = result.group.id;
  await chrome.storage.local.set({ [QUICK_LINK_ACTIVE_GROUP_KEY]: activeQuickLinkGroupId });
  closeQuickLinkPicker();
  await refreshQuickLinkViews();
  showToast(`已添加到“${result.group.name}”分组`);
}

async function showQuickLinkForm(linkId = '') {
  const dialog = document.getElementById('quickLinkDialog');
  const form = document.getElementById('quickLinkForm');
  const urlInput = document.getElementById('quickLinkUrl');
  const nameInput = document.getElementById('quickLinkName');
  const descriptionInput = document.getElementById('quickLinkDescription');
  const groupSelect = document.getElementById('quickLinkGroupId');
  const badgeInput = document.getElementById('quickLinkBadge');
  const colorInput = document.getElementById('quickLinkColor');
  const title = document.getElementById('quickLinkDialogTitle');
  const subtitle = document.getElementById('quickLinkDialogSubtitle');
  const submitButton = document.getElementById('quickLinkSubmitButton');
  if (!dialog || !form || !urlInput || !groupSelect) return;

  const data = await getQuickLinkData();
  const link = linkId ? data.links.find(item => item.id === linkId) : null;
  const selectedGroupId = link?.groupId || (
    activeQuickLinkGroupId === QUICK_LINK_ALL_GROUP_ID
      ? data.groups[0].id
      : activeQuickLinkGroupId
  );
  const selectedGroup = data.groups.find(group => group.id === selectedGroupId) || data.groups[0];

  groupSelect.innerHTML = data.groups.map(group => `
    <option value="${escapeAttr(group.id)}"${group.id === selectedGroupId ? ' selected' : ''}>${escapeHtml(group.name)}</option>`).join('');
  form.dataset.mode = link ? 'edit' : 'create';
  form.dataset.linkId = link?.id || '';
  form.dataset.colorTouched = 'false';
  urlInput.value = link?.url || '';
  if (nameInput) nameInput.value = link?.title || '';
  if (descriptionInput) descriptionInput.value = link?.description || '';
  if (badgeInput) badgeInput.value = link?.badge || '';
  if (colorInput) {
    const fallbackColor = globalThis.TabOutFavoritesMetadata?.getCategoryColor(selectedGroup.name) || '#65758b';
    colorInput.value = globalThis.TabOutFavoritesMetadata?.sanitizeColor(link?.color, fallbackColor) || fallbackColor;
  }
  if (title) title.textContent = link ? '编辑网站' : '添加网站';
  if (subtitle) subtitle.textContent = link ? '更新快捷方式信息' : '创建新的快捷方式';
  if (submitButton) submitButton.textContent = link ? '保存修改' : '添加网站';

  if (!dialog.open) dialog.showModal();
  requestAnimationFrame(() => (link ? nameInput : urlInput)?.focus());
}

function hideQuickLinkForm() {
  const dialog = document.getElementById('quickLinkDialog');
  if (dialog?.open) dialog.close();
}

async function showQuickLinkGroupForm(mode) {
  const form = document.getElementById('quickLinkGroupForm');
  const input = document.getElementById('quickLinkGroupName');
  if (!form || !input) return;

  form.dataset.mode = mode === 'rename' ? 'rename' : 'create';
  input.value = '';
  if (form.dataset.mode === 'rename') {
    const data = await getQuickLinkData();
    input.value = data.groups.find(group => group.id === activeQuickLinkGroupId)?.name || '';
  }
  form.hidden = false;
  input.focus();
  input.select();
}

function hideQuickLinkGroupForm() {
  const form = document.getElementById('quickLinkGroupForm');
  if (form) form.hidden = true;
}

function clearQuickLinkDragIndicators() {
  document.querySelectorAll('.quick-link-item.drop-before, .quick-link-item.drop-after').forEach(item => {
    item.classList.remove('drop-before', 'drop-after');
  });
  document.querySelectorAll('.quick-link-group-tab.drop-target, .quick-links-strip.drop-target').forEach(item => {
    item.classList.remove('drop-target');
  });
}

function getWorkspaceDefaultName() {
  return `工作空间 ${new Date().toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}`;
}

function renderWorkspaceFavicons(tabs) {
  const seen = new Set();
  const favicons = [];

  for (const tab of tabs) {
    const hostname = getTabHostname(tab.url);
    if (!hostname || hostname === 'local-files' || seen.has(hostname)) continue;
    seen.add(hostname);
    favicons.push({
      url: getLocalFaviconUrl(tab.url, 32),
      hostname,
    });
  }

  const visible = favicons.slice(0, 6);
  const extraCount = favicons.length - visible.length;
  return visible.map(item =>
    `<img class="workspace-favicon" src="${escapeAttr(item.url)}" alt="" title="${escapeAttr(item.hostname)}">`
  ).join('') + (extraCount > 0 ? `<span class="workspace-favicon-more">+${extraCount}</span>` : '');
}

async function renderWorkspaces() {
  const list = document.getElementById('workspaceList');
  const count = document.getElementById('workspaceCount');
  if (!list) return;

  const workspaces = await getWorkspaces();
  if (count) count.textContent = workspaces.length ? `${workspaces.length}` : '';

  if (workspaces.length === 0) {
    list.innerHTML = '<div class="workspace-empty">还没有保存的工作空间。</div>';
    return;
  }

  list.innerHTML = workspaces.map(workspace => {
    const safeId = escapeAttr(workspace.id);
    const safeName = escapeAttr(workspace.name);
    const tabCount = workspace.tabs.length;
    return `
      <article class="workspace-card" data-workspace-id="${safeId}">
        <div class="workspace-card-header">
          <div class="workspace-name-area">
            <div class="workspace-name-display">
              <h3 class="workspace-name" title="${safeName}">${escapeHtml(workspace.name)}</h3>
              <button class="workspace-icon-btn" data-action="show-workspace-rename" title="重命名工作空间" aria-label="重命名 ${safeName}">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 7.125 16.862 4.487M18 14.25v4.125A2.625 2.625 0 0 1 15.375 21H5.625A2.625 2.625 0 0 1 3 18.375V8.625A2.625 2.625 0 0 1 5.625 6H9.75" /></svg>
              </button>
            </div>
            <form class="workspace-rename-form" hidden>
              <input class="workspace-input workspace-rename-input" type="text" maxlength="80" value="${safeName}" aria-label="工作空间名称" required>
              <button class="workspace-icon-btn" type="submit" title="保存名称" aria-label="保存名称">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.25" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>
              </button>
              <button class="workspace-icon-btn" type="button" data-action="cancel-workspace-rename" title="取消重命名" aria-label="取消重命名">
                <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.25" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
              </button>
            </form>
          </div>
          <button class="workspace-icon-btn danger" data-action="delete-workspace" title="删除工作空间" aria-label="删除 ${safeName}">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673A2.25 2.25 0 0 1 15.916 21H8.084a2.25 2.25 0 0 1-2.244-1.327L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0V4.477c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
          </button>
        </div>
        <div class="workspace-card-meta">
          <span>${tabCount} 个标签页</span>
          <span class="dot"></span>
          <span>更新于 ${escapeHtml(timeAgo(workspace.updatedAt))}</span>
        </div>
        <div class="workspace-favicons">${renderWorkspaceFavicons(workspace.tabs)}</div>
        <div class="workspace-card-actions">
          <button class="workspace-action-btn primary" data-action="restore-workspace-new">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75A2.25 2.25 0 0 1 6 4.5h12a2.25 2.25 0 0 1 2.25 2.25v10.5A2.25 2.25 0 0 1 18 19.5H6a2.25 2.25 0 0 1-2.25-2.25V6.75Z" /><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9h16.5" /></svg>
            新窗口打开
          </button>
          <button class="workspace-action-btn" data-action="restore-workspace-merge">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M12 5v14m7-7H5" /></svg>
            合并到当前窗口
          </button>
          <button class="workspace-action-btn icon-only" data-action="refresh-workspace" title="使用当前窗口更新快照" aria-label="使用当前窗口更新 ${safeName}">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992V4.356m-.985 12.663a9 9 0 1 1 .674-9.352L21.015 9.348" /></svg>
          </button>
        </div>
      </article>`;
  }).join('');
}

function showWorkspaceCreateForm() {
  const form = document.getElementById('workspaceCreateForm');
  const input = document.getElementById('workspaceNameInput');
  if (!form) return;
  form.hidden = false;
  if (input) {
    input.value = getWorkspaceDefaultName();
    input.select();
  }
}

function hideWorkspaceCreateForm() {
  const form = document.getElementById('workspaceCreateForm');
  if (form) form.hidden = true;
}

function setWorkspaceRenameMode(card, editing) {
  if (!card) return;
  const display = card.querySelector('.workspace-name-display');
  const form = card.querySelector('.workspace-rename-form');
  if (display) display.hidden = editing;
  if (form) form.hidden = !editing;
  if (editing) {
    const input = form?.querySelector('.workspace-rename-input');
    if (input) {
      input.focus();
      input.select();
    }
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function renderTabChip(tab, groupDomain, urlCounts = {}) {
  const titleDomain = groupDomain.startsWith('__type-') ? getTabHostname(tab.url) : groupDomain;
  const label = getTabDisplayTitle(tab, titleDomain);
  const count = urlCounts[tab.url] || 1;
  const dupeTag = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
  const chipClass = count > 1 ? ' chip-has-dupes' : '';
  const safeUrl = escapeAttr(tab.url || '');
  const safeTitle = escapeAttr(label);
  const faviconUrl = getLocalFaviconUrl(tab.url, 16);
  const readableUrl = getReadableUrl(tab.url);
  const quickLinkMatch = quickLinkLookup.get(getQuickLinkUrlKey(tab.url));
  const favoriteClass = quickLinkMatch ? ' is-favorite' : '';
  const favoriteTitle = quickLinkMatch
    ? getQuickLinkDuplicateMessage(quickLinkMatch)
    : '添加到常用标签页';

  return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
    ${faviconUrl ? `<img class="chip-favicon" src="${escapeAttr(faviconUrl)}" alt="">` : ''}
    <div class="chip-body">
      <span class="chip-text">${escapeHtml(label)}</span>
      <div class="chip-url">${escapeHtml(readableUrl)}</div>
    </div>
    ${dupeTag}
    <div class="chip-actions">
      <button class="chip-action chip-favorite${favoriteClass}" data-action="show-quick-link-picker" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="${escapeAttr(favoriteTitle)}" aria-label="${escapeAttr(favoriteTitle)}" aria-pressed="${quickLinkMatch ? 'true' : 'false'}">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m12 2.75 2.86 5.8 6.4.93-4.63 4.51 1.09 6.38L12 17.36l-5.72 3.01 1.09-6.38-4.63-4.51 6.4-.93L12 2.75Z" /></svg>
      </button>
      <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="保存到稍后查看">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
      </button>
      <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="关闭此标签页">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>
  </div>`;
}

function buildOverflowChips(hiddenTabs, urlCounts = {}, groupDomain = '') {
  const hiddenChips = hiddenTabs.map(tab => {
    return renderTabChip(tab, groupDomain, urlCounts);
  }).join('');

  return `
    <div class="page-chips-overflow" hidden>${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">还有 ${hiddenTabs.length} 项</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    已打开 ${tabCount} 个标签页
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge duplicate-badge">
        ${totalExtras} 个重复项
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    return renderTabChip(tab, group.domain, urlCounts);
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts, group.domain) : '');

  const groupName = isLanding ? '首页' : (group.label || friendlyDomain(group.domain));
  const visibleUrls = tabs.map(tab => encodeURIComponent(tab.url || '')).join(',');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      关闭全部 ${tabCount} 个标签页
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        关闭 ${totalExtras} 个重复项
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}" data-tab-urls="${visibleUrls}" data-group-label="${escapeAttr(groupName)}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${escapeHtml(groupName)}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">标签页</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredColumn');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} 项`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const faviconUrl = getLocalFaviconUrl(item.url, 16);
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <img class="deferred-favicon" src="${faviconUrl}" alt="">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="移除">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs once, or reuses incrementally maintained state
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard({ refreshTabs = !openTabsInitialized, renderAuxiliary = true } = {}) {
  const renderVersion = ++dashboardRenderVersion;
  syncGroupingModeControl();

  if (renderAuxiliary) {
    const greetingEl = document.getElementById('greeting');
    const dateEl     = document.getElementById('dateDisplay');
    if (greetingEl) greetingEl.textContent = getGreeting();
    if (dateEl)     dateEl.textContent     = getDateDisplay();
    await renderQuickLinks();
    await renderWorkspaces();
  }

  // --- Fetch once, then use event-maintained state ---
  if (refreshTabs || !openTabsInitialized) await fetchOpenTabs();
  const realTabs = getRealTabs();
  await renderTabAnalytics();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  const groupByControl = document.getElementById('groupByControl');
  if (activeGroupingMode === 'type') groupByControl?.setAttribute('aria-busy', 'true');
  const nextGroupedTabs = activeGroupingMode === 'type'
    ? await buildTypeGroups(realTabs)
    : domainGroups;
  if (renderVersion !== dashboardRenderVersion) return;
  groupedTabs = nextGroupedTabs;
  groupByControl?.removeAttribute('aria-busy');

  // --- Render grouped cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');
  const openTabsSectionTitle = document.getElementById('openTabsSectionTitle');
  const openTabsSearch       = document.getElementById('openTabsSearch');
  const openTabsSearchClear  = document.getElementById('openTabsSearchClear');
  const openTabsSearchStatus = document.getElementById('openTabsSearchStatus');
  const openTabsSearchEmpty  = document.getElementById('openTabsSearchEmpty');
  const searchQuery          = getOpenTabSearchQuery();
  const visibleGroups        = filterDomainGroupsForSearch(groupedTabs, searchQuery);
  const visibleTabCount      = visibleGroups.reduce((sum, group) => sum + group.tabs.length, 0);

  if (openTabsSearch && openTabsSearch.value !== openTabSearchQuery) {
    openTabsSearch.value = openTabSearchQuery;
  }
  if (openTabsSearchClear) {
    openTabsSearchClear.classList.toggle('visible', !!searchQuery);
  }
  if (openTabsSearchStatus) {
    openTabsSearchStatus.textContent = searchQuery
      ? `${visibleTabCount} 个匹配项`
      : '';
  }

  if (groupedTabs.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = '已打开标签页';
    const groupCount = visibleGroups.length;
    const tabCount = searchQuery ? visibleTabCount : realTabs.length;
    const closeLabel = searchQuery
      ? `关闭全部 ${tabCount} 个匹配项`
      : `关闭全部 ${tabCount} 个标签页`;
    const closeButton = tabCount > 0
      ? ` &nbsp;&middot;&nbsp; <button class="action-btn close-tabs compact" data-action="close-all-open-tabs">${ICONS.close} ${closeLabel}</button>`
      : '';
    const groupUnit = activeGroupingMode === 'type' ? '个类型' : '个域名';
    openTabsSectionCount.innerHTML = `${groupCount} ${groupUnit}${closeButton}`;
    openTabsMissionsEl.innerHTML = visibleGroups.map(g => renderDomainCard(g)).join('');
    if (openTabsSearchEmpty) openTabsSearchEmpty.style.display = visibleGroups.length === 0 ? 'block' : 'none';
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statTabs = document.getElementById('statTabs');
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  if (renderAuxiliary) await renderDeferredColumn();
}

async function renderDashboard(options) {
  await renderStaticDashboard(options);
}


document.addEventListener('error', (e) => {
  const el = e.target;
  if (!(el instanceof HTMLImageElement)) return;
  if (el.classList.contains('timeline-node-favicon')) {
    const fallback = document.createElement('span');
    fallback.className = 'timeline-node-fallback';
    fallback.textContent = el.dataset.fallback || '页';
    el.replaceWith(fallback);
    return;
  }
  if (
    !el.classList.contains('chip-favicon') &&
    !el.classList.contains('deferred-favicon') &&
    !el.classList.contains('quick-link-favicon') &&
    !el.classList.contains('workspace-favicon')
  ) return;
  el.hidden = true;
}, true);


/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;
  const workspaceCard = actionEl.closest('.workspace-card');

  if (action === 'toast-action') {
    const handler = toastActionHandler;
    toastActionHandler = null;
    clearTimeout(toastHideTimer);
    document.getElementById('toast')?.classList.remove('visible');
    actionEl.hidden = true;
    if (handler) await handler();
    return;
  }

  // ---- View switcher and timeline ----
  if (action === 'switch-view') {
    await setAppView(actionEl.dataset.view);
    return;
  }

  if (action === 'switch-group-mode') {
    const nextMode = actionEl.dataset.groupMode === 'type' ? 'type' : 'domain';
    if (nextMode === activeGroupingMode) return;
    activeGroupingMode = nextMode;
    syncGroupingModeControl();
    await renderDashboard({ refreshTabs: false, renderAuxiliary: false });
    return;
  }

  if (action === 'refresh-timeline') {
    await renderTimelineView(true);
    return;
  }

  if (action === 'scroll-timeline-top') {
    scrollTimelineToTop();
    return;
  }

  if (action === 'expand-timeline-session') {
    const requiredLimit = Number(actionEl.dataset.requiredLimit);
    if (!timelineSnapshot || !Number.isFinite(requiredLimit)) return;
    timelineNodeLimit = Math.max(timelineNodeLimit, requiredLimit);
    paintTimelineSnapshot(timelineSnapshot);
    return;
  }

  if (action === 'load-more-timeline') {
    if (!timelineSnapshot) return;
    timelineNodeLimit += TIMELINE_NODE_PAGE_SIZE;
    paintTimelineSnapshot(timelineSnapshot);
    return;
  }

  if (action === 'open-timeline-node') {
    await activateTimelineNode(actionEl.dataset.tabId, actionEl.dataset.nodeUrl);
    return;
  }

  // ---- Workspaces ----
  if (action === 'show-workspace-form') {
    showWorkspaceCreateForm();
    return;
  }

  if (action === 'cancel-workspace-form') {
    hideWorkspaceCreateForm();
    return;
  }

  if (action === 'show-workspace-rename') {
    setWorkspaceRenameMode(workspaceCard, true);
    return;
  }

  if (action === 'cancel-workspace-rename') {
    setWorkspaceRenameMode(workspaceCard, false);
    return;
  }

  if (action === 'delete-workspace') {
    const id = workspaceCard?.dataset.workspaceId;
    const name = workspaceCard?.querySelector('.workspace-name')?.textContent || '此工作空间';
    if (!id || !window.confirm(`确定删除“${name}”吗？`)) return;
    await deleteWorkspace(id);
    await renderWorkspaces();
    showToast('工作空间已删除');
    return;
  }

  if (action === 'restore-workspace-new' || action === 'restore-workspace-merge') {
    const id = workspaceCard?.dataset.workspaceId;
    if (!id) return;
    actionEl.disabled = true;
    try {
      const mode = action === 'restore-workspace-merge' ? 'merge' : 'new';
      const workspace = await restoreWorkspace(id, mode);
      showToast(mode === 'merge'
        ? `已将 ${workspace.tabs.length} 个标签页合并到当前窗口`
        : `已在新窗口打开 ${workspace.tabs.length} 个标签页`);
      await renderWorkspaces();
    } catch (err) {
      console.warn('[tab-out] Workspace restore failed:', err);
      showToast('无法恢复工作空间');
    } finally {
      actionEl.disabled = false;
    }
    return;
  }

  if (action === 'refresh-workspace') {
    const id = workspaceCard?.dataset.workspaceId;
    if (!id) return;
    actionEl.disabled = true;
    try {
      const tabs = await chrome.tabs.query({ currentWindow: true });
      const snapshotTabs = tabs.map(normalizeWorkspaceTab).filter(Boolean);
      if (snapshotTabs.length === 0) throw new Error('No restorable tabs');
      await updateWorkspace(id, { tabs: snapshotTabs });
      await renderWorkspaces();
      showToast(`工作空间已更新，共 ${snapshotTabs.length} 个标签页`);
    } catch (err) {
      console.warn('[tab-out] Workspace update failed:', err);
      showToast('无法更新工作空间');
    } finally {
      actionEl.disabled = false;
    }
    return;
  }

  if (action === 'import-workspaces') {
    const input = document.getElementById('workspaceImportInput');
    if (input) {
      input.value = '';
      input.click();
    }
    return;
  }

  if (action === 'export-workspaces') {
    try {
      await exportWorkspaces();
      showToast('工作空间已导出');
    } catch {
      showToast('没有可导出的工作空间');
    }
    return;
  }

  // ---- Quick links ----
  if (action === 'show-quick-link-picker') {
    e.stopPropagation();
    const url = actionEl.dataset.tabUrl;
    if (!url) return;
    await openQuickLinkPicker(actionEl, url, actionEl.dataset.tabTitle || url);
    return;
  }

  if (action === 'add-picker-tab-to-group') {
    e.stopPropagation();
    const groupId = actionEl.dataset.groupId;
    if (!groupId) return;
    actionEl.disabled = true;
    try {
      await addPickerTabToGroup(groupId);
    } catch (error) {
      console.warn('[tab-out] Failed to add open tab to quick links:', error);
      showToast('无法添加到常用标签页');
    } finally {
      actionEl.disabled = false;
    }
    return;
  }

  if (action === 'show-quick-link-picker-group-form') {
    e.stopPropagation();
    const form = document.getElementById('quickLinkPickerGroupForm');
    const input = document.getElementById('quickLinkPickerGroupName');
    if (form) form.hidden = false;
    if (input) {
      input.value = '';
      input.focus();
    }
    positionQuickLinkPicker(quickLinkPickerState?.anchor);
    return;
  }

  if (action === 'import-quick-links') {
    const input = document.getElementById('quickLinkImportInput');
    if (input) {
      input.value = '';
      input.click();
    }
    return;
  }

  if (action === 'export-quick-links') {
    try {
      const count = await exportQuickLinks();
      showToast(`已导出 ${count} 个常用标签页`);
    } catch (error) {
      console.warn('[tab-out] Quick link export failed:', error);
      showToast('无法导出常用标签页');
    }
    return;
  }

  if (action === 'select-quick-link-group') {
    const groupId = actionEl.dataset.groupId;
    if (!groupId || groupId === activeQuickLinkGroupId) return;
    activeQuickLinkGroupId = groupId;
    await chrome.storage.local.set({ [QUICK_LINK_ACTIVE_GROUP_KEY]: activeQuickLinkGroupId });
    hideQuickLinkForm();
    hideQuickLinkGroupForm();
    await renderQuickLinks();
    return;
  }

  if (action === 'show-quick-link-group-create') {
    await showQuickLinkGroupForm('create');
    return;
  }

  if (action === 'show-quick-link-group-rename') {
    if (activeQuickLinkGroupId === QUICK_LINK_ALL_GROUP_ID) return;
    await showQuickLinkGroupForm('rename');
    return;
  }

  if (action === 'cancel-quick-link-group-form') {
    hideQuickLinkGroupForm();
    return;
  }

  if (action === 'delete-quick-link-group') {
    if (activeQuickLinkGroupId === QUICK_LINK_ALL_GROUP_ID) return;
    const data = await getQuickLinkData();
    const group = data.groups.find(item => item.id === activeQuickLinkGroupId);
    const fallbackGroup = data.groups.find(item => item.id !== activeQuickLinkGroupId);
    if (!group || !fallbackGroup) {
      showToast('至少需要保留一个分组');
      return;
    }
    const linkCount = data.links.filter(link => link.groupId === group.id).length;
    const moveNotice = linkCount > 0
      ? `，其中 ${linkCount} 个标签将移到“${fallbackGroup.name}”`
      : '';
    if (!window.confirm(`确定删除分组“${group.name}”吗${moveNotice}？`)) return;
    const nextGroup = await deleteQuickLinkGroup(group.id);
    activeQuickLinkGroupId = nextGroup.id;
    await chrome.storage.local.set({ [QUICK_LINK_ACTIVE_GROUP_KEY]: activeQuickLinkGroupId });
    hideQuickLinkGroupForm();
    await renderQuickLinks();
    showToast('分组已删除');
    return;
  }

  if (action === 'show-quick-link-form') {
    await showQuickLinkForm();
    return;
  }

  if (action === 'edit-quick-link') {
    const id = actionEl.dataset.linkId;
    if (!id) return;
    await showQuickLinkForm(id);
    return;
  }

  if (action === 'cancel-quick-link') {
    hideQuickLinkForm();
    return;
  }

  if (action === 'open-quick-link') {
    await openQuickLink(actionEl.dataset.linkUrl);
    return;
  }

  if (action === 'remove-quick-link') {
    const id = actionEl.dataset.linkId;
    if (!id) return;
    const removed = await removeQuickLink(id);
    await refreshQuickLinkViews();
    showToast('常用标签页已删除', {
      label: '撤销',
      handler: async () => {
        if (!await restoreQuickLink(removed)) {
          showToast('该网址已存在，无法撤销');
          return;
        }
        await refreshQuickLinkViews();
        showToast('已恢复常用标签页');
      },
    });
    return;
  }

  if (action === 'accept-favorite-suggestion') {
    const group = await acceptFavoriteSuggestion(actionEl.dataset.linkId);
    if (!group) return;
    await renderQuickLinks({ classify: false });
    showToast(`已归入“${group.name}”分组`);
    return;
  }

  if (action === 'dismiss-favorite-suggestion') {
    if (!await dismissFavoriteSuggestion(actionEl.dataset.linkId)) return;
    await renderQuickLinks({ classify: false });
    showToast('已忽略分类建议');
    return;
  }

  // ---- Clear open-tab search ----
  if (action === 'clear-open-tab-search') {
    openTabSearchQuery = '';
    const input = document.getElementById('openTabsSearch');
    if (input) input.value = '';
    await renderDashboard({ refreshTabs: false, renderAuxiliary: false });
    if (input) input.focus();
    return;
  }

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('多余的 Tab Out 页面已关闭');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.hidden = false;
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    const match = openTabs.find(tab => tab.url === tabUrl);
    if (match) await removeTabsWithAnalytics(match.id, 'close-single');

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast('标签页已关闭');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('标签页保存失败');
      return;
    }

    const match = openTabs.find(tab => tab.url === tabUrl);
    if (match) await removeTabsWithAnalytics(match.id, 'save-for-later');

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('已保存到稍后查看');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const cardUrls = card ? decodeUrlList(card.dataset.tabUrls) : [];
    const group    = groupedTabs.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group && cardUrls.length === 0) return;

    const urls      = cardUrls.length > 0 ? cardUrls : group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = cardUrls.length > 0 || group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    if (group && urls.length === group.tabs.length) {
      const activeGroups = activeGroupingMode === 'type' ? groupedTabs : domainGroups;
      const idx = activeGroups.indexOf(group);
      if (idx !== -1) activeGroups.splice(idx, 1);
    }

    const groupLabel = card?.dataset.groupLabel || (group
      ? (group.domain === '__landing-pages__' ? '首页' : (group.label || friendlyDomain(group.domain)))
      : '此分组');
    showToast(`已关闭 ${groupLabel} 中的 ${urls.length} 个标签页`);

    const statTabs = document.getElementById('statTabs');
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.duplicate-badge').forEach(badge => {
        badge.style.transition = 'opacity 0.2s';
        badge.style.opacity    = '0';
        setTimeout(() => badge.remove(), 200);
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('重复标签页已关闭，每个页面保留一份');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const searchQuery = getOpenTabSearchQuery();
    const visibleGroups = filterDomainGroupsForSearch(groupedTabs, searchQuery);
    const visibleUrlSet = new Set(visibleGroups.flatMap(group => group.tabs.map(tab => tab.url)));
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .filter(t => !searchQuery || visibleUrlSet.has(t.url))
      .map(t => t.url);
    if (allUrls.length === 0) return;
    if (searchQuery) {
      await closeTabsExact(allUrls);
    } else {
      await closeTabsByUrls(allUrls);
    }
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast(searchQuery ? '匹配的标签页已全部关闭' : '标签页已全部关闭，重新出发。');
    return;
  }
});

// ---- Quick link drag sorting and cross-group moves ----
document.addEventListener('dragstart', (e) => {
  const linkItem = e.target.closest('.quick-link-item[draggable="true"]');
  const groupTab = e.target.closest('.quick-link-group-tab[draggable="true"]');

  if (linkItem?.dataset.linkId) {
    quickLinkDragState = { type: 'link', id: linkItem.dataset.linkId };
    linkItem.classList.add('dragging');
  } else if (groupTab?.dataset.groupId) {
    quickLinkDragState = { type: 'group', id: groupTab.dataset.groupId };
    groupTab.classList.add('dragging');
  } else {
    return;
  }

  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${quickLinkDragState.type}:${quickLinkDragState.id}`);
  }
});

document.addEventListener('dragover', (e) => {
  if (!quickLinkDragState) return;
  const linkItem = e.target.closest('.quick-link-item[draggable="true"]');
  const groupTab = e.target.closest('.quick-link-group-tab[draggable="true"]');
  const strip = e.target.closest('#quickLinksStrip');

  if (quickLinkDragState.type === 'link' && (linkItem || groupTab || strip)) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearQuickLinkDragIndicators();
    if (linkItem && linkItem.dataset.linkId !== quickLinkDragState.id) {
      const rect = linkItem.getBoundingClientRect();
      linkItem.classList.add(e.clientX > rect.left + rect.width / 2 ? 'drop-after' : 'drop-before');
    } else if (groupTab) {
      groupTab.classList.add('drop-target');
    } else if (strip) {
      strip.classList.add('drop-target');
    }
    return;
  }

  if (quickLinkDragState.type === 'group' && groupTab && groupTab.dataset.groupId !== quickLinkDragState.id) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    clearQuickLinkDragIndicators();
    groupTab.classList.add('drop-target');
  }
});

document.addEventListener('drop', async (e) => {
  if (!quickLinkDragState) return;
  const dragState = { ...quickLinkDragState };
  const linkItem = e.target.closest('.quick-link-item[draggable="true"]');
  const groupTab = e.target.closest('.quick-link-group-tab[draggable="true"]');
  const strip = e.target.closest('#quickLinksStrip');
  let handled = false;

  try {
    if (dragState.type === 'link') {
      if (linkItem && linkItem.dataset.linkId !== dragState.id) {
        const rect = linkItem.getBoundingClientRect();
        const position = e.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
        await moveQuickLink(dragState.id, linkItem.dataset.groupId, linkItem.dataset.linkId, position);
        handled = true;
      } else if (groupTab) {
        await moveQuickLink(dragState.id, groupTab.dataset.groupId);
        handled = true;
      } else if (strip && activeQuickLinkGroupId !== QUICK_LINK_ALL_GROUP_ID) {
        await moveQuickLink(dragState.id, activeQuickLinkGroupId);
        handled = true;
      }
    } else if (dragState.type === 'group' && groupTab && groupTab.dataset.groupId !== dragState.id) {
      const rect = groupTab.getBoundingClientRect();
      const position = e.clientX > rect.left + rect.width / 2 ? 'after' : 'before';
      await moveQuickLinkGroup(dragState.id, groupTab.dataset.groupId, position);
      handled = true;
    }

    if (handled) {
      e.preventDefault();
      await renderQuickLinks();
    }
  } catch (error) {
    console.warn('[tab-out] Quick link drag operation failed:', error);
    showToast('排序失败，请重试');
  }
  clearQuickLinkDragIndicators();
  document.querySelectorAll('.quick-link-item.dragging, .quick-link-group-tab.dragging').forEach(item => {
    item.classList.remove('dragging');
  });
  quickLinkDragState = null;
});

document.addEventListener('dragend', () => {
  clearQuickLinkDragIndicators();
  document.querySelectorAll('.quick-link-item.dragging, .quick-link-group-tab.dragging').forEach(item => {
    item.classList.remove('dragging');
  });
  quickLinkDragState = null;
});

document.addEventListener('click', (e) => {
  const picker = document.getElementById('quickLinkPicker');
  if (!picker || picker.hidden || picker.contains(e.target)) return;
  if (e.target.closest('[data-action="show-quick-link-picker"]')) return;
  closeQuickLinkPicker();
});

document.getElementById('quickLinkDialog')?.addEventListener('click', (e) => {
  if (e.target === e.currentTarget) hideQuickLinkForm();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeQuickLinkPicker();
});

window.addEventListener('resize', () => {
  if (quickLinkPickerState) positionQuickLinkPicker(quickLinkPickerState.anchor);
});

window.addEventListener('scroll', scheduleTimelineBackToTopSync, { passive: true });

document.addEventListener('scroll', (e) => {
  const picker = document.getElementById('quickLinkPicker');
  if (!quickLinkPickerState || picker?.contains(e.target)) return;
  closeQuickLinkPicker();
}, true);

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id === 'quickLinkColor') {
    const form = document.getElementById('quickLinkForm');
    if (form) form.dataset.colorTouched = 'true';
    return;
  }

  if (e.target.id === 'openTabsSearch') {
    openTabSearchQuery = e.target.value || '';
    await renderDashboard({ refreshTabs: false, renderAuxiliary: false });
    const input = document.getElementById('openTabsSearch');
    if (input) input.focus();
    return;
  }

  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div class="archive-empty-result">没有结果</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});

// ---- Workspace and quick link forms ----
document.addEventListener('submit', async (e) => {
  if (e.target.id === 'quickLinkPickerGroupForm') {
    e.preventDefault();
    if (!quickLinkPickerState) return;
    const input = document.getElementById('quickLinkPickerGroupName');
    const name = input?.value.trim() || '';
    if (!name) return;

    try {
      const group = await addQuickLinkGroup(name);
      await addPickerTabToGroup(group.id);
    } catch (error) {
      const message = error.message === 'Duplicate group name'
        ? '分组名称已存在，请直接选择该分组'
        : '无法创建分组';
      showToast(message);
      input?.focus();
      input?.select();
    }
    return;
  }

  if (e.target.id === 'workspaceCreateForm') {
    e.preventDefault();
    const input = document.getElementById('workspaceNameInput');
    try {
      const workspace = await createWorkspaceFromCurrentWindow(input?.value || '');
      hideWorkspaceCreateForm();
      await renderWorkspaces();
      showToast(`已将 ${workspace.tabs.length} 个标签页保存到 ${workspace.name}`);
    } catch (err) {
      console.warn('[tab-out] Workspace save failed:', err);
      showToast('当前窗口没有可保存的标签页');
    }
    return;
  }

  if (e.target.classList.contains('workspace-rename-form')) {
    e.preventDefault();
    const card = e.target.closest('.workspace-card');
    const id = card?.dataset.workspaceId;
    const input = e.target.querySelector('.workspace-rename-input');
    if (!id || !input?.value.trim()) return;
    await updateWorkspace(id, { name: input.value });
    await renderWorkspaces();
    showToast('工作空间已重命名');
    return;
  }

  if (e.target.id === 'quickLinkGroupForm') {
    e.preventDefault();
    const input = document.getElementById('quickLinkGroupName');
    const name = input?.value.trim() || '';
    if (!name) return;
    try {
      if (e.target.dataset.mode === 'rename') {
        await renameQuickLinkGroup(activeQuickLinkGroupId, name);
        showToast('分组已重命名');
      } else {
        const group = await addQuickLinkGroup(name);
        activeQuickLinkGroupId = group.id;
        await chrome.storage.local.set({ [QUICK_LINK_ACTIVE_GROUP_KEY]: activeQuickLinkGroupId });
        showToast('分组已创建');
      }
      hideQuickLinkGroupForm();
      await renderQuickLinks();
    } catch (error) {
      showToast(error.message === 'Duplicate group name' ? '分组名称已存在' : '无法保存分组');
      input?.focus();
    }
    return;
  }

  if (e.target.id !== 'quickLinkForm') return;
  e.preventDefault();

  const urlInput = document.getElementById('quickLinkUrl');
  const nameInput = document.getElementById('quickLinkName');
  const descriptionInput = document.getElementById('quickLinkDescription');
  const groupSelect = document.getElementById('quickLinkGroupId');
  const badgeInput = document.getElementById('quickLinkBadge');
  const colorInput = document.getElementById('quickLinkColor');
  const rawUrl = urlInput?.value || '';
  const rawName = nameInput?.value || '';
  const groupId = groupSelect?.value || activeQuickLinkGroupId;

  try {
    const editing = e.target.dataset.mode === 'edit';
    const result = editing
      ? await updateQuickLink(e.target.dataset.linkId, {
          url: rawUrl,
          title: rawName,
          description: descriptionInput?.value || '',
          groupId,
          badge: badgeInput?.value || '',
          color: colorInput?.value || '',
        })
      : await addQuickLink(rawUrl, rawName, groupId, {
          description: descriptionInput?.value || '',
          badge: badgeInput?.value || '',
          color: e.target.dataset.colorTouched === 'true' ? colorInput?.value || '' : '',
          metadataSource: (
            descriptionInput?.value.trim() ||
            badgeInput?.value.trim() ||
            e.target.dataset.colorTouched === 'true'
          ) ? 'custom' : 'auto',
        });
    if (result.status === 'duplicate') {
      showToast(getQuickLinkDuplicateMessage(result));
      return;
    }
    hideQuickLinkForm();
    await refreshQuickLinkViews();
    showToast(editing ? '常用标签页已更新' : '常用标签页已添加');
  } catch {
    showToast('请输入有效的网址');
    if (urlInput) urlInput.focus();
  }
});

// ---- Workspace and quick link JSON imports ----
document.addEventListener('change', async (e) => {
  if (e.target.id === 'quickLinkGroupId') {
    const form = document.getElementById('quickLinkForm');
    const colorInput = document.getElementById('quickLinkColor');
    if (form?.dataset.colorTouched !== 'true' && colorInput) {
      const data = await getQuickLinkData();
      const group = data.groups.find(item => item.id === e.target.value) || data.groups[0];
      colorInput.value = globalThis.TabOutFavoritesMetadata?.getCategoryColor(group.name) || '#65758b';
    }
    return;
  }

  if (e.target.id === 'quickLinkUrl') {
    const form = document.getElementById('quickLinkForm');
    if (form?.dataset.mode !== 'create' || !isSupportedQuickLinkUrl(normalizeQuickLinkUrl(e.target.value))) return;
    const data = await getQuickLinkData();
    const groupId = document.getElementById('quickLinkGroupId')?.value;
    const group = data.groups.find(item => item.id === groupId) || data.groups[0];
    const nameInput = document.getElementById('quickLinkName');
    const descriptionInput = document.getElementById('quickLinkDescription');
    const badgeInput = document.getElementById('quickLinkBadge');
    const colorInput = document.getElementById('quickLinkColor');
    const metadata = globalThis.TabOutFavoritesMetadata?.inferFavoriteMetadata({
      url: normalizeQuickLinkUrl(e.target.value),
      title: nameInput?.value || '',
      groupName: group.name,
    });
    if (nameInput && !nameInput.value.trim()) nameInput.value = getQuickLinkTitle(normalizeQuickLinkUrl(e.target.value));
    if (descriptionInput && !descriptionInput.value.trim()) descriptionInput.value = metadata?.description || '';
    if (badgeInput && !badgeInput.value.trim()) badgeInput.value = metadata?.badge || '';
    if (colorInput && form.dataset.colorTouched !== 'true' && metadata?.color) colorInput.value = metadata.color;
    return;
  }

  if (e.target.id === 'quickLinkImportInput') {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const result = await importQuickLinks(file);
      await refreshQuickLinkViews();
      const skipped = result.linksSkipped > 0 ? `，跳过 ${result.linksSkipped} 个重复网址` : '';
      showToast(`已导入 ${result.linksAdded} 个标签页，新增 ${result.groupsAdded} 个分组${skipped}`);
    } catch (err) {
      console.warn('[tab-out] Quick link import failed:', err);
      showToast('常用标签页 JSON 文件无效');
    }
    return;
  }

  if (e.target.id !== 'workspaceImportInput') return;
  const file = e.target.files?.[0];
  if (!file) return;

  try {
    const count = await importWorkspaces(file);
    await renderWorkspaces();
    showToast(`已导入 ${count} 个工作空间`);
  } catch (err) {
    console.warn('[tab-out] Workspace import failed:', err);
    showToast('工作空间 JSON 文件无效');
  }
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
renderDashboard();
