/**
 * Tab Out group preference store.
 *
 * Remembers which favorite group the user last chose for each hostname so
 * smart recommendations can follow personal habits instead of only generic
 * categories. Data stays in chrome.storage.local; it is never synced or
 * sent anywhere.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'tabOutGroupPreferences';
  const MAX_ENTRIES = 200;

  // Accepts a full URL or a bare hostname. categoryService/categoryCache keep
  // their own stricter hostname-only normalizers for the Service Worker
  // classification path; a shared util is deferred until a module loadable in
  // both contexts exists (page + SW importScripts have different constraints).
  function normalizeHostname(value) {
    let text = String(value || '').trim().toLowerCase();
    if (!text) return '';
    if (text.includes('://')) {
      try {
        text = new URL(text).hostname;
      } catch {
        return '';
      }
    } else {
      text = text.split('/')[0].split('?')[0];
    }
    return text.replace(/^www\./, '').replace(/\.$/, '');
  }

  async function readAll() {
    try {
      const state = await chrome.storage.local.get(STORAGE_KEY);
      const raw = state?.[STORAGE_KEY];
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
    } catch (error) {
      console.warn('[tab-out] Group preference read failed:', error);
      return {};
    }
  }

  async function writeAll(entries) {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: entries });
      return true;
    } catch (error) {
      console.warn('[tab-out] Group preference write failed:', error);
      return false;
    }
  }

  function pruneLru(entries) {
    const keys = Object.keys(entries);
    if (keys.length <= MAX_ENTRIES) return entries;
    keys.sort((a, b) => String(entries[a]?.updatedAt || '').localeCompare(String(entries[b]?.updatedAt || '')));
    const pruned = { ...entries };
    for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete pruned[key];
    return pruned;
  }

  async function record(rawHostname, groupName) {
    const hostname = normalizeHostname(rawHostname);
    const name = String(groupName || '').trim().slice(0, 30);
    if (!hostname || !name) return false;
    const entries = await readAll();
    entries[hostname] = { groupName: name, updatedAt: new Date().toISOString() };
    return writeAll(pruneLru(entries));
  }

  async function get(rawHostname) {
    const hostname = normalizeHostname(rawHostname);
    if (!hostname) return null;
    const entries = await readAll();
    return entries[hostname] || null;
  }

  async function getAll() {
    return readAll();
  }

  async function clear() {
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
      return true;
    } catch (error) {
      console.warn('[tab-out] Group preference clear failed:', error);
      return false;
    }
  }

  globalThis.TabOutGroupPreferenceService = Object.freeze({
    STORAGE_KEY,
    MAX_ENTRIES,
    normalizeHostname,
    record,
    get,
    getAll,
    clear,
  });
})();
