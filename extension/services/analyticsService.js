(() => {
  'use strict';

  const LEGACY_STORAGE_KEY = 'tabAnalytics';
  const SCHEMA_VERSION = 1;
  const DEFAULT_MEMORY_MB_PER_TAB = 50;
  const DEFAULT_WARNING_THRESHOLD = 50;
  let analyticsWriteQueue = Promise.resolve();
  let migrationPromise = null;

  function getLocalDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function createDefaultAnalytics() {
    return {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        estimatedMemoryMbPerTab: DEFAULT_MEMORY_MB_PER_TAB,
        warningThreshold: DEFAULT_WARNING_THRESHOLD,
      },
      days: {},
      lifetime: {
        closedTabs: 0,
        estimatedMemoryMb: 0,
      },
    };
  }

  function normalizeAnalytics(raw) {
    const defaults = createDefaultAnalytics();
    if (!raw || typeof raw !== 'object') return defaults;
    const storedMemoryEstimate = Number(raw.settings?.estimatedMemoryMbPerTab);
    const storedWarningThreshold = Number(raw.settings?.warningThreshold);

    return {
      schemaVersion: SCHEMA_VERSION,
      settings: {
        estimatedMemoryMbPerTab: storedMemoryEstimate > 0
          ? storedMemoryEstimate
          : DEFAULT_MEMORY_MB_PER_TAB,
        warningThreshold: storedWarningThreshold > 0
          ? storedWarningThreshold
          : DEFAULT_WARNING_THRESHOLD,
      },
      days: raw.days && typeof raw.days === 'object' ? raw.days : {},
      lifetime: {
        closedTabs: Number(raw.lifetime?.closedTabs) || 0,
        estimatedMemoryMb: Number(raw.lifetime?.estimatedMemoryMb) || 0,
      },
    };
  }

  async function migrateLegacyAnalytics() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
      const existing = await globalThis.TabOutDatabase?.getAnalytics();
      if (existing) return normalizeAnalytics(existing);

      let legacy = null;
      try {
        const stored = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
        legacy = stored?.[LEGACY_STORAGE_KEY] || null;
      } catch {
        // IndexedDB remains usable even if chrome.storage is unavailable.
      }

      const analytics = normalizeAnalytics(legacy);
      await globalThis.TabOutDatabase?.setAnalytics(analytics);
      if (legacy) {
        try { await chrome.storage.local.remove(LEGACY_STORAGE_KEY); }
        catch { /* The IndexedDB migration has already completed. */ }
      }
      return analytics;
    })();
    return migrationPromise;
  }

  async function getAnalytics() {
    await migrateLegacyAnalytics();
    return normalizeAnalytics(await globalThis.TabOutDatabase?.getAnalytics());
  }

  function getEligibleTabs(tabs) {
    return (Array.isArray(tabs) ? tabs : []).filter(tab => {
      const url = String(tab?.url || '');
      return url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file://');
    });
  }

  function calculateDuplicateStats(tabs) {
    const eligibleTabs = getEligibleTabs(tabs);
    const counts = new Map();
    eligibleTabs.forEach(tab => counts.set(tab.url, (counts.get(tab.url) || 0) + 1));

    let duplicateExtras = 0;
    counts.forEach(count => {
      duplicateExtras += Math.max(0, count - 1);
    });

    return {
      tabCount: eligibleTabs.length,
      duplicateExtras,
      duplicateRate: eligibleTabs.length > 0
        ? Math.round((duplicateExtras / eligibleTabs.length) * 100)
        : 0,
    };
  }

  async function recordTabsClosed(count, source = 'cleanup') {
    const safeCount = Math.max(0, Math.trunc(Number(count) || 0));
    if (safeCount === 0) return getAnalytics();

    analyticsWriteQueue = analyticsWriteQueue.catch(error => {
      console.warn('[tab-out] Recovering analytics write queue:', error);
    }).then(async () => {
      const analytics = await getAnalytics();
      const dateKey = getLocalDateKey();
      const memoryMb = safeCount * analytics.settings.estimatedMemoryMbPerTab;
      const storedDay = analytics.days[dateKey] || {};
      const day = {
        closedTabs: Number(storedDay.closedTabs) || 0,
        estimatedMemoryMb: Number(storedDay.estimatedMemoryMb) || 0,
        closeActions: Number(storedDay.closeActions) || 0,
        sources: storedDay.sources && typeof storedDay.sources === 'object'
          ? { ...storedDay.sources }
          : {},
      };

      day.closedTabs += safeCount;
      day.estimatedMemoryMb += memoryMb;
      day.closeActions += 1;
      day.sources[source] = (day.sources[source] || 0) + safeCount;
      analytics.days[dateKey] = day;
      analytics.lifetime.closedTabs += safeCount;
      analytics.lifetime.estimatedMemoryMb += memoryMb;

      const retainedDays = Object.keys(analytics.days).sort().slice(-90);
      analytics.days = Object.fromEntries(retainedDays.map(key => [key, analytics.days[key]]));
      await globalThis.TabOutDatabase?.setAnalytics(analytics);
      return analytics;
    });

    return analyticsWriteQueue;
  }

  async function getDashboard(tabs) {
    await analyticsWriteQueue;
    const analytics = await getAnalytics();
    const dateKey = getLocalDateKey();
    return {
      analytics,
      today: analytics.days[dateKey] || {
        closedTabs: 0,
        estimatedMemoryMb: 0,
        closeActions: 0,
        sources: {},
      },
      duplicateStats: calculateDuplicateStats(tabs),
      dateKey,
    };
  }

  globalThis.TabOutAnalyticsService = Object.freeze({
    getAnalytics,
    recordTabsClosed,
    calculateDuplicateStats,
    getDashboard,
  });
})();
