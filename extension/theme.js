/**
 * Tab Out theme bootstrap.
 *
 * Loaded synchronously in <head> so `data-theme` is resolved before the
 * first paint (no flash). The user's mode choice (system | light | dark)
 * persists in localStorage — synchronous storage avoids the theme flash an
 * async chrome.storage read would cause. Stays strictly local.
 */
(() => {
  'use strict';

  const STORAGE_KEY = 'tabOutThemeMode';
  const VALID_MODES = ['system', 'light', 'dark'];
  const DARK_QUERY = '(prefers-color-scheme: dark)';

  function resolveMode(mode, prefersDark) {
    if (mode === 'light' || mode === 'dark') return mode;
    return prefersDark ? 'dark' : 'light';
  }

  function getMode() {
    try {
      const stored = globalThis.localStorage?.getItem(STORAGE_KEY);
      return VALID_MODES.includes(stored) ? stored : 'system';
    } catch {
      return 'system';
    }
  }

  function prefersDarkScheme() {
    try {
      return Boolean(globalThis.matchMedia?.(DARK_QUERY)?.matches);
    } catch {
      return false;
    }
  }

  function apply() {
    const resolved = resolveMode(getMode(), prefersDarkScheme());
    const root = globalThis.document?.documentElement;
    if (root?.dataset) root.dataset.theme = resolved;
    return resolved;
  }

  function setMode(mode) {
    const next = VALID_MODES.includes(mode) ? mode : 'system';
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, next);
    } catch {
      // Storage blocked: still apply the choice for this session.
    }
    return apply();
  }

  // Follow live OS scheme changes while in system mode.
  try {
    globalThis.matchMedia?.(DARK_QUERY)?.addEventListener?.('change', () => {
      if (getMode() === 'system') apply();
    });
  } catch {
    // Engines without addEventListener skip live updates; the theme is
    // still resolved correctly on every page load.
  }

  globalThis.TabOutTheme = Object.freeze({
    STORAGE_KEY,
    VALID_MODES,
    resolveMode,
    getMode,
    setMode,
    apply,
  });

  apply();
})();
