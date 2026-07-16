(() => {
  'use strict';

  const CHANNEL = 'tab-out-worker';

  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ channel: CHANNEL, type, payload }, response => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message));
          return;
        }
        if (!response?.ok) {
          reject(new Error(response?.error || `Worker request failed: ${type}`));
          return;
        }
        resolve(response.data);
      });
    });
  }

  async function getCategories(hostnames) {
    const result = await send('categories:get', { hostnames });
    return new Map(Object.entries(result?.categories || {}));
  }

  function clearCategoryCache() {
    return send('categories:clear');
  }

  function getTimelineSnapshot(options) {
    return send('timeline:get', options);
  }

  function getPersistedSessions() {
    return send('sessions:get');
  }

  function getAnalyticsDashboard() {
    return send('analytics:get');
  }

  function recordTabsClosed(count, source) {
    return send('analytics:recordClosed', { count, source });
  }

  globalThis.TabOutBackgroundClient = Object.freeze({
    getCategories,
    clearCategoryCache,
    getTimelineSnapshot,
    getPersistedSessions,
    getAnalyticsDashboard,
    recordTabsClosed,
  });
})();
