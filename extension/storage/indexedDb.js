(() => {
  'use strict';

  const DATABASE_NAME = 'tab-out';
  const DATABASE_VERSION = 1;
  const STORES = Object.freeze({
    sessions: 'sessions',
    analytics: 'analytics',
    categoryCache: 'categoryCache',
  });
  let databasePromise = null;

  function openDatabase() {
    if (databasePromise) return databasePromise;
    if (!globalThis.indexedDB) return Promise.resolve(null);

    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORES.sessions)) {
          const sessions = database.createObjectStore(STORES.sessions, { keyPath: 'id' });
          sessions.createIndex('startTime', 'startTime');
          sessions.createIndex('capturedAt', 'capturedAt');
        }
        if (!database.objectStoreNames.contains(STORES.analytics)) {
          database.createObjectStore(STORES.analytics, { keyPath: 'key' });
        }
        if (!database.objectStoreNames.contains(STORES.categoryCache)) {
          const categories = database.createObjectStore(STORES.categoryCache, { keyPath: 'hostname' });
          categories.createIndex('updatedAt', 'updatedAt');
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error || new Error('Could not open Tab Out database'));
      };
      request.onblocked = () => {
        console.warn('[tab-out] IndexedDB upgrade is blocked by another extension page');
      };
    });

    return databasePromise;
  }

  async function runRequest(storeName, mode, operation) {
    const database = await openDatabase();
    if (!database) return null;

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;

      try {
        request = operation(store);
      } catch (error) {
        reject(error);
        return;
      }

      request.onsuccess = () => resolve(request.result ?? null);
      request.onerror = () => reject(request.error || new Error(`IndexedDB request failed: ${storeName}`));
    });
  }

  function get(storeName, key) {
    return runRequest(storeName, 'readonly', store => store.get(key));
  }

  function put(storeName, value) {
    return runRequest(storeName, 'readwrite', store => store.put(value));
  }

  function getAll(storeName) {
    return runRequest(storeName, 'readonly', store => store.getAll());
  }

  function clear(storeName) {
    return runRequest(storeName, 'readwrite', store => store.clear());
  }

  async function replaceSessions(blocks, capturedAt = Date.now()) {
    const database = await openDatabase();
    if (!database) return false;
    const safeBlocks = Array.isArray(blocks) ? blocks : [];

    await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORES.sessions, 'readwrite');
      const store = transaction.objectStore(STORES.sessions);
      store.clear();
      safeBlocks.forEach(block => {
        if (!block?.id) return;
        store.put({ ...block, capturedAt });
      });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('Could not persist timeline sessions'));
      transaction.onabort = () => reject(transaction.error || new Error('Timeline session write was aborted'));
    });
    return true;
  }

  async function getSessions() {
    const sessions = await getAll(STORES.sessions);
    return (Array.isArray(sessions) ? sessions : [])
      .sort((a, b) => Number(b.startTime || 0) - Number(a.startTime || 0));
  }

  function getAnalytics() {
    return get(STORES.analytics, 'tabAnalytics');
  }

  function setAnalytics(value) {
    return put(STORES.analytics, {
      ...value,
      key: 'tabAnalytics',
      updatedAt: new Date().toISOString(),
    });
  }

  function normalizeHostname(hostname) {
    return String(hostname || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  }

  function getCategory(hostname) {
    const key = normalizeHostname(hostname);
    return key ? get(STORES.categoryCache, key) : Promise.resolve(null);
  }

  function setCategory(hostname, category) {
    const key = normalizeHostname(hostname);
    if (!key || !category) return Promise.resolve(false);
    return put(STORES.categoryCache, {
      hostname: key,
      category,
      updatedAt: new Date().toISOString(),
    }).then(() => true);
  }

  function clearCategoryCache() {
    return clear(STORES.categoryCache).then(() => true);
  }

  globalThis.TabOutDatabase = Object.freeze({
    openDatabase,
    replaceSessions,
    getSessions,
    getAnalytics,
    setAnalytics,
    getCategory,
    setCategory,
    clearCategoryCache,
    constants: Object.freeze({
      databaseName: DATABASE_NAME,
      databaseVersion: DATABASE_VERSION,
      stores: STORES,
    }),
  });
})();
