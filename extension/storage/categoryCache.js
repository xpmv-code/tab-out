(() => {
  'use strict';

  const LEGACY_DATABASE_NAME = 'tab-out-category-cache';
  const LEGACY_STORE_NAME = 'categories';
  let legacyDatabasePromise = null;

  function normalizeHostname(hostname) {
    return String(hostname || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  }

  function openLegacyDatabase() {
    if (legacyDatabasePromise) return legacyDatabasePromise;
    if (!globalThis.indexedDB) return Promise.resolve(null);

    legacyDatabasePromise = new Promise(resolve => {
      const request = indexedDB.open(LEGACY_DATABASE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onupgradeneeded = () => {
        request.transaction?.abort();
        resolve(null);
      };
    });
    return legacyDatabasePromise;
  }

  async function readLegacyCategory(hostname) {
    const database = await openLegacyDatabase();
    if (!database?.objectStoreNames.contains(LEGACY_STORE_NAME)) return null;

    return new Promise(resolve => {
      const transaction = database.transaction(LEGACY_STORE_NAME, 'readonly');
      const request = transaction.objectStore(LEGACY_STORE_NAME).get(hostname);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => resolve(null);
    });
  }

  async function get(hostname) {
    const key = normalizeHostname(hostname);
    if (!key) return null;

    try {
      const cached = await globalThis.TabOutDatabase?.getCategory(key);
      if (cached) return cached;

      const legacy = await readLegacyCategory(key);
      if (legacy?.category) await globalThis.TabOutDatabase?.setCategory(key, legacy.category);
      return legacy;
    } catch (error) {
      console.warn('[tab-out] Category cache read failed:', error);
      return null;
    }
  }

  async function set(hostname, category) {
    try {
      return await globalThis.TabOutDatabase?.setCategory(hostname, category) || false;
    } catch (error) {
      console.warn('[tab-out] Category cache write failed:', error);
      return false;
    }
  }

  async function clear() {
    try {
      await globalThis.TabOutDatabase?.clearCategoryCache();
      const legacyDatabase = await openLegacyDatabase();
      if (legacyDatabase?.objectStoreNames.contains(LEGACY_STORE_NAME)) {
        await new Promise((resolve, reject) => {
          const transaction = legacyDatabase.transaction(LEGACY_STORE_NAME, 'readwrite');
          transaction.objectStore(LEGACY_STORE_NAME).clear();
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
      }
      return true;
    } catch (error) {
      console.warn('[tab-out] Category cache clear failed:', error);
      return false;
    }
  }

  globalThis.TabOutCategoryCache = Object.freeze({ get, set, clear });
})();
