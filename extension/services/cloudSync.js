(function (global) {
  'use strict';

  const STORAGE_KEYS = {
    session: 'tabOutSyncSession',
    document: 'tabOutSyncDocument',
    pending: 'tabOutSyncPending',
    lastApplied: 'tabOutSyncLastAppliedAt',
    quickLinks: 'quickLinkData',
  };
  const TABLE_NAME = 'quick_link_sync_documents';
  const MAX_GROUPS = 100;
  const MAX_LINKS = 2000;
  const MAX_TOMBSTONES = 5000;
  const MAX_SYNC_ATTEMPTS = 6;

  let initialized = false;
  let pendingEmail = '';
  let syncPromise = null;
  let syncTimer = null;
  let pollTimer = null;
  let retryDelayMs = 3000;
  let lastStatus = { state: 'local', message: '仅在本地使用' };

  function looksLikeServerSecret(key) {
    if (/^(?:sb_secret_|service_role\b)/i.test(key)) return true;
    const parts = key.split('.');
    if (parts.length !== 3 || typeof global.atob !== 'function') return false;
    try {
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      const payload = JSON.parse(global.atob(padded));
      return payload && payload.role === 'service_role';
    } catch (_) {
      return false;
    }
  }

  function getConfig() {
    const raw = global.TAB_OUT_SYNC_CONFIG;
    if (!raw || typeof raw !== 'object') return null;

    try {
      const parsed = new URL(String(raw.supabaseUrl || '').trim());
      const key = String(raw.publishableKey || raw.anonKey || '').trim();
      if (parsed.protocol !== 'https:' || !/^[a-z0-9-]+\.supabase\.co$/i.test(parsed.hostname)) return null;
      if (parsed.pathname !== '/' || parsed.search || parsed.hash || !key || looksLikeServerSecret(key)) return null;
      return { url: parsed.origin, key: key };
    } catch (_) {
      return null;
    }
  }

  function isConfigured() {
    return Boolean(getConfig());
  }

  function safeString(value, maxLength, fallback) {
    const result = String(value === null || value === undefined ? '' : value).trim().slice(0, maxLength);
    return result || fallback || '';
  }

  function validTimestamp(value, fallback) {
    const text = String(value || '');
    return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : fallback;
  }

  function timestampValue(value) {
    const number = Date.parse(value || '');
    return Number.isFinite(number) ? number : 0;
  }

  function safeUrl(value) {
    try {
      const parsed = new URL(String(value || '').trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
      return parsed.href;
    } catch (_) {
      return '';
    }
  }

  function urlKey(value) {
    try {
      const parsed = new URL(value);
      parsed.hash = '';
      return parsed.href;
    } catch (_) {
      return '';
    }
  }

  function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (!value || typeof value !== 'object') return value;
    const sorted = {};
    Object.keys(value).sort().forEach(function (key) {
      sorted[key] = stableValue(value[key]);
    });
    return sorted;
  }

  function stableStringify(value) {
    return JSON.stringify(stableValue(value));
  }

  function sameValue(left, right) {
    return stableStringify(left) === stableStringify(right);
  }

  function cleanGroup(group, index) {
    const createdAt = validTimestamp(group.createdAt, new Date(0).toISOString());
    return {
      id: safeString(group.id, 160, 'group-' + index),
      name: safeString(group.name, 30, '未命名分组'),
      createdAt: createdAt,
      updatedAt: validTimestamp(group.updatedAt, createdAt),
      order: Number.isFinite(Number(group.order)) ? Number(group.order) : index,
    };
  }

  function cleanLink(link, index) {
    const url = safeUrl(link.url);
    if (!url) return null;
    const createdAt = validTimestamp(link.createdAt, new Date(0).toISOString());
    return {
      id: safeString(link.id, 160, 'link-' + index),
      url: url,
      title: safeString(link.title, 200, url),
      groupId: safeString(link.groupId, 160, ''),
      createdAt: createdAt,
      description: safeString(link.description, 2000, ''),
      favicon: safeString(link.favicon, 2000, ''),
      category: safeString(link.category, 100, ''),
      badge: safeString(link.badge, 60, ''),
      color: safeString(link.color, 40, ''),
      metadataSource: safeString(link.metadataSource, 60, ''),
      suggestedCategory: safeString(link.suggestedCategory, 100, ''),
      suggestionStatus: safeString(link.suggestionStatus, 60, ''),
      suggestionCheckedAt: safeString(link.suggestionCheckedAt, 64, ''),
      updatedAt: validTimestamp(link.updatedAt, createdAt),
      order: Number.isFinite(Number(link.order)) ? Number(link.order) : index,
    };
  }

  function normalizeDocument(value) {
    const raw = value && typeof value === 'object' ? value : {};
    const groups = (Array.isArray(raw.groups) ? raw.groups : [])
      .slice(0, MAX_GROUPS)
      .filter(function (group) { return group && typeof group === 'object'; })
      .map(cleanGroup);
    const groupIds = new Set();
    const uniqueGroups = groups.filter(function (group) {
      if (groupIds.has(group.id)) return false;
      groupIds.add(group.id);
      return true;
    });

    const links = (Array.isArray(raw.links) ? raw.links : [])
      .slice(0, MAX_LINKS)
      .filter(function (link) { return link && typeof link === 'object'; })
      .map(cleanLink)
      .filter(Boolean);
    const linkIds = new Set();
    const uniqueLinks = links.filter(function (link) {
      if (linkIds.has(link.id)) return false;
      linkIds.add(link.id);
      return true;
    });

    const tombstoneMap = new Map();
    (Array.isArray(raw.tombstones) ? raw.tombstones : []).forEach(function (entry) {
      if (!entry || (entry.kind !== 'group' && entry.kind !== 'link')) return;
      const id = safeString(entry.id, 160, '');
      const deletedAt = validTimestamp(entry.deletedAt, '');
      if (!id || !deletedAt) return;
      const key = entry.kind + ':' + id;
      const current = tombstoneMap.get(key);
      if (!current || timestampValue(deletedAt) > timestampValue(current.deletedAt)) {
        tombstoneMap.set(key, { kind: entry.kind, id: id, deletedAt: deletedAt });
      }
    });

    return {
      schemaVersion: 1,
      groups: uniqueGroups,
      links: uniqueLinks,
      tombstones: Array.from(tombstoneMap.values())
        .sort(function (a, b) { return timestampValue(b.deletedAt) - timestampValue(a.deletedAt); })
        .slice(0, MAX_TOMBSTONES),
    };
  }

  function groupPayload(group) {
    return { id: group.id, name: group.name, createdAt: group.createdAt };
  }

  function linkPayload(link) {
    return {
      id: link.id,
      url: link.url,
      title: link.title,
      groupId: link.groupId,
      createdAt: link.createdAt,
      description: link.description,
      favicon: link.favicon,
      category: link.category,
      badge: link.badge,
      color: link.color,
      metadataSource: link.metadataSource,
      suggestedCategory: link.suggestedCategory,
      suggestionStatus: link.suggestionStatus,
      suggestionCheckedAt: link.suggestionCheckedAt,
    };
  }

  function buildLocalDocument(appData, previousDocument) {
    const data = appData && typeof appData === 'object' ? appData : {};
    const previous = previousDocument ? normalizeDocument(previousDocument) : null;
    const previousGroups = new Map((previous ? previous.groups : []).map(function (group) { return [group.id, group]; }));
    const previousLinks = new Map((previous ? previous.links : []).map(function (link) { return [link.id, link]; }));
    const now = new Date().toISOString();

    const groups = (Array.isArray(data.groups) ? data.groups : []).slice(0, MAX_GROUPS).map(function (group, index) {
      const cleaned = cleanGroup(group || {}, index);
      const old = previousGroups.get(cleaned.id);
      const order = index;
      const changed = !old || !sameValue(groupPayload(old), groupPayload(cleaned)) || old.order !== order;
      return Object.assign({}, cleaned, {
        updatedAt: changed ? now : old.updatedAt,
        order: order,
      });
    });

    const links = (Array.isArray(data.links) ? data.links : []).slice(0, MAX_LINKS).map(function (link, index) {
      const cleaned = cleanLink(link || {}, index);
      if (!cleaned) return null;
      const old = previousLinks.get(cleaned.id);
      const order = index;
      const changed = !old || !sameValue(linkPayload(old), linkPayload(cleaned)) || old.order !== order;
      return Object.assign({}, cleaned, {
        updatedAt: changed ? now : old.updatedAt,
        order: order,
      });
    }).filter(Boolean);

    const activeGroupIds = new Set(groups.map(function (group) { return group.id; }));
    const activeLinkIds = new Set(links.map(function (link) { return link.id; }));
    const tombstones = previous ? previous.tombstones.slice() : [];
    const knownTombstones = new Map(tombstones.map(function (entry) { return [entry.kind + ':' + entry.id, entry]; }));

    function markDeleted(kind, id) {
      const key = kind + ':' + id;
      const existing = knownTombstones.get(key);
      if (existing && timestampValue(existing.deletedAt) >= timestampValue(now)) return;
      const tombstone = { kind: kind, id: id, deletedAt: now };
      knownTombstones.set(key, tombstone);
    }

    if (previous) {
      previous.groups.forEach(function (group) {
        if (!activeGroupIds.has(group.id)) markDeleted('group', group.id);
      });
      previous.links.forEach(function (link) {
        if (!activeLinkIds.has(link.id)) markDeleted('link', link.id);
      });
    }

    return normalizeDocument({
      schemaVersion: 1,
      groups: groups,
      links: links,
      tombstones: Array.from(knownTombstones.values()),
    });
  }

  function chooseLatestById(remoteItems, localItems) {
    const byId = new Map();
    (remoteItems || []).forEach(function (item) { byId.set(item.id, item); });
    (localItems || []).forEach(function (item) {
      const existing = byId.get(item.id);
      if (!existing || timestampValue(item.updatedAt) >= timestampValue(existing.updatedAt)) {
        byId.set(item.id, item);
      }
    });
    return Array.from(byId.values());
  }

  function sortByOrder(left, right) {
    return Number(left.order || 0) - Number(right.order || 0)
      || timestampValue(left.updatedAt) - timestampValue(right.updatedAt)
      || String(left.id).localeCompare(String(right.id));
  }

  function mergeDocuments(localDocument, remoteDocument) {
    const local = normalizeDocument(localDocument);
    const remote = normalizeDocument(remoteDocument);
    const tombstoneMap = new Map();

    remote.tombstones.concat(local.tombstones).forEach(function (entry) {
      const key = entry.kind + ':' + entry.id;
      const existing = tombstoneMap.get(key);
      if (!existing || timestampValue(entry.deletedAt) > timestampValue(existing.deletedAt)) {
        tombstoneMap.set(key, entry);
      }
    });

    const tombstones = Array.from(tombstoneMap.values());
    const deletedAt = new Map(tombstones.map(function (entry) {
      return [entry.kind + ':' + entry.id, timestampValue(entry.deletedAt)];
    }));

    let groups = chooseLatestById(remote.groups, local.groups).filter(function (group) {
      return (deletedAt.get('group:' + group.id) || 0) < timestampValue(group.updatedAt);
    });
    let links = chooseLatestById(remote.links, local.links).filter(function (link) {
      return (deletedAt.get('link:' + link.id) || 0) < timestampValue(link.updatedAt);
    });

    const aliases = new Map();
    const canonicalByName = new Map();
    groups.slice().sort(function (a, b) {
      return timestampValue(b.updatedAt) - timestampValue(a.updatedAt)
        || Number(a.order || 0) - Number(b.order || 0)
        || String(a.id).localeCompare(String(b.id));
    }).forEach(function (group) {
      const key = group.name.trim().toLocaleLowerCase();
      const canonical = canonicalByName.get(key);
      if (!canonical) {
        canonicalByName.set(key, group);
        aliases.set(group.id, group.id);
      } else {
        aliases.set(group.id, canonical.id);
      }
    });

    groups = Array.from(canonicalByName.values()).sort(sortByOrder);
    if (groups.length === 0) {
      const recovery = {
        id: 'group-sync-recovery',
        name: '常用',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        order: 0,
      };
      groups = [recovery];
      aliases.set(recovery.id, recovery.id);
    }

    const fallbackGroupId = groups[0].id;
    const groupIds = new Set(groups.map(function (group) { return group.id; }));
    links = links.map(function (link) {
      const mappedId = aliases.get(link.groupId) || link.groupId;
      return Object.assign({}, link, {
        groupId: groupIds.has(mappedId) ? mappedId : fallbackGroupId,
      });
    });

    const byUrl = new Map();
    links.slice().sort(function (a, b) {
      return timestampValue(b.updatedAt) - timestampValue(a.updatedAt)
        || Number(a.order || 0) - Number(b.order || 0)
        || String(a.id).localeCompare(String(b.id));
    }).forEach(function (link) {
      const key = urlKey(link.url);
      if (key && !byUrl.has(key)) byUrl.set(key, link);
    });
    links = Array.from(byUrl.values()).sort(sortByOrder).map(function (link, index) {
      return Object.assign({}, link, { order: index });
    });
    groups = groups.map(function (group, index) {
      return Object.assign({}, group, { order: index });
    });

    return normalizeDocument({
      schemaVersion: 1,
      groups: groups,
      links: links,
      tombstones: tombstones,
    });
  }

  function toQuickLinkData(document) {
    const normalized = normalizeDocument(document);
    const groups = normalized.groups.slice().sort(sortByOrder).map(function (group) {
      return { id: group.id, name: group.name, createdAt: group.createdAt };
    });
    const defaultGroupId = groups[0] ? groups[0].id : 'group-sync-recovery';
    const validGroupIds = new Set(groups.map(function (group) { return group.id; }));
    const links = normalized.links.slice().sort(sortByOrder).map(function (link) {
      const item = linkPayload(link);
      item.groupId = validGroupIds.has(item.groupId) ? item.groupId : defaultGroupId;
      return item;
    });
    return { schemaVersion: 3, groups: groups, links: links };
  }

  async function storageGet(keys) {
    return chrome.storage.local.get(keys);
  }

  async function storageSet(values) {
    return chrome.storage.local.set(values);
  }

  function getErrorMessage(body, status) {
    if (body && typeof body === 'object') {
      const message = body.msg || body.message || body.error_description || body.error;
      if (message) return String(message);
    }
    return '云端请求失败（HTTP ' + status + '）';
  }

  async function request(path, options) {
    const config = getConfig();
    if (!config) throw new Error('请先在 config.local.js 中配置 Supabase 项目地址和 Publishable key。');

    const settings = options || {};
    const headers = {
      apikey: config.key,
      'Content-Type': 'application/json',
    };
    // Publishable keys are not user JWTs. Send Authorization only when a real
    // authenticated access token is available; keep the API key in apikey.
    if (settings.token) headers.Authorization = 'Bearer ' + settings.token;
    if (settings.prefer) headers.Prefer = settings.prefer;
    const response = await fetch(config.url + path, {
      method: settings.method || 'GET',
      headers: headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      cache: 'no-store',
    });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch (_) { body = { message: text }; }
    }
    if (!response.ok) {
      const error = new Error(getErrorMessage(body, response.status));
      error.status = response.status;
      error.payload = body;
      throw error;
    }
    return body;
  }

  function getOriginPattern() {
    const config = getConfig();
    return config ? config.url + '/*' : '';
  }

  async function hasHostPermission() {
    const pattern = getOriginPattern();
    if (!pattern || !chrome.permissions || !chrome.permissions.contains) return false;
    try { return await chrome.permissions.contains({ origins: [pattern] }); }
    catch (_) { return false; }
  }

  async function ensureHostPermission(requestUser) {
    const pattern = getOriginPattern();
    const config = getConfig();
    if (!config || !pattern) throw new Error('云同步尚未配置。');
    if (requestUser) {
      if (!chrome.permissions || !chrome.permissions.request) {
        throw new Error('当前浏览器未提供主机权限接口，请检查扩展权限设置。');
      }
      // Invoke request before any other asynchronous operation so Chrome can associate
      // the optional-origin permission prompt with the user's button/form action.
      let granted = false;
      try { granted = await chrome.permissions.request({ origins: [pattern] }); }
      catch (_) { granted = false; }
      if (granted) return true;
    }
    if (await hasHostPermission()) return true;
    if (!requestUser) throw new Error('需要 Supabase 主机访问权限。请打开云同步面板后点击“立即同步”。');
    throw new Error('未获得 Supabase 访问权限，常用标签仍保存在本地。');
  }

  async function refreshSessionIfNeeded(session) {
    if (!session) return null;
    if (Number(session.expiresAt || 0) > Date.now() + 60000) return session;
    if (!session.refreshToken) {
      await chrome.storage.local.remove(STORAGE_KEYS.session);
      throw new Error('登录状态已失效，请重新登录 Tab Out 账号。');
    }

    const result = await request('/auth/v1/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: session.refreshToken },
    }).catch(async function (error) {
      if (error.status === 400 || error.status === 401) {
        await chrome.storage.local.remove(STORAGE_KEYS.session);
        throw new Error('登录状态已失效，请重新登录 Tab Out 账号。');
      }
      throw error;
    });
    if (!result || !result.access_token || !result.refresh_token) {
      await chrome.storage.local.remove(STORAGE_KEYS.session);
      throw new Error('无法刷新登录状态，请重新登录 Tab Out 账号。');
    }
    const refreshed = {
      userId: result.user && result.user.id ? result.user.id : session.userId,
      email: result.user && result.user.email ? result.user.email : session.email,
      accessToken: result.access_token,
      refreshToken: result.refresh_token,
      expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000,
    };
    await storageSet({ [STORAGE_KEYS.session]: refreshed });
    return refreshed;
  }

  async function getActiveSession(refresh) {
    const stored = await storageGet(STORAGE_KEYS.session);
    const session = stored[STORAGE_KEYS.session] || null;
    if (!session || !session.accessToken || !session.userId) return null;
    return refresh === false ? session : refreshSessionIfNeeded(session);
  }

  async function requireSession() {
    const session = await getActiveSession(true);
    if (!session) throw new Error('请先登录 Tab Out 云同步账号。');
    return session;
  }

  async function readRemoteRow(session) {
    const path = '/rest/v1/' + TABLE_NAME
      + '?select=user_id%2Cdocument%2Crevision%2Cupdated_at'
      + '&user_id=eq.' + encodeURIComponent(session.userId);
    const rows = await request(path, { token: session.accessToken });
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  }

  async function insertRemoteRow(session, document) {
    return request('/rest/v1/' + TABLE_NAME, {
      method: 'POST',
      token: session.accessToken,
      prefer: 'return=representation',
      body: { user_id: session.userId, document: document },
    });
  }

  async function updateRemoteRow(session, revision, document) {
    const path = '/rest/v1/' + TABLE_NAME
      + '?user_id=eq.' + encodeURIComponent(session.userId)
      + '&revision=eq.' + encodeURIComponent(String(revision));
    return request(path, {
      method: 'PATCH',
      token: session.accessToken,
      prefer: 'return=representation',
      body: { document: document },
    });
  }

  async function getLocalSnapshot(session) {
    const stored = await storageGet([
      STORAGE_KEYS.quickLinks,
      STORAGE_KEYS.document,
      STORAGE_KEYS.pending,
    ]);
    const meta = stored[STORAGE_KEYS.document];
    const previous = meta && meta.ownerId === session.userId ? meta.document : null;
    const fallback = { schemaVersion: 3, groups: [], links: [] };
    const localData = stored[STORAGE_KEYS.quickLinks] || fallback;
    const document = buildLocalDocument(localData, previous);
    return {
      localData: localData,
      persistedLocalData: stored[STORAGE_KEYS.quickLinks],
      document: document,
      meta: meta,
      pending: stored[STORAGE_KEYS.pending] || null,
    };
  }

  async function applyMergedDocument(session, document, expectedSnapshot) {
    const stored = await storageGet([
      STORAGE_KEYS.quickLinks,
      STORAGE_KEYS.pending,
      STORAGE_KEYS.session,
    ]);
    const currentSessionAtWrite = stored[STORAGE_KEYS.session];
    if (!currentSessionAtWrite || currentSessionAtWrite.userId !== session.userId) {
      throw new Error('Tab Out 账号已切换，请重新同步。');
    }
    if (expectedSnapshot && !sameValue(stored[STORAGE_KEYS.quickLinks], expectedSnapshot.persistedLocalData)) {
      // A favorite was edited after the optimistic pre-write check. Keep it and retry.
      return false;
    }
    const expectedPending = expectedSnapshot && expectedSnapshot.pending;
    const appData = toQuickLinkData(document);
    const dataChanged = !sameValue(stored[STORAGE_KEYS.quickLinks], appData);
    const nonce = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    const updates = {
      [STORAGE_KEYS.document]: { ownerId: session.userId, document: document },
    };

    if (dataChanged) {
      updates[STORAGE_KEYS.quickLinks] = appData;
      updates[STORAGE_KEYS.lastApplied] = {
        ownerId: session.userId,
        nonce: nonce,
        appliedAt: Date.now(),
      };
      // Suppress the storage-change notification echo in this page; the explicit
      // event below will refresh it once. Other open Tab Out pages still receive it.
      if (global.document && typeof global.dispatchEvent === 'function') {
        global.__tabOutSyncLastAppliedNonce = nonce;
      }
    }

    await storageSet(updates);

    const current = await storageGet([STORAGE_KEYS.pending, STORAGE_KEYS.session]);
    const currentSession = current[STORAGE_KEYS.session];
    const currentPending = current[STORAGE_KEYS.pending];
    const sameOwnerStillSignedIn = currentSession && currentSession.userId === session.userId;
    const pendingWasSynced = currentPending
      && currentPending.ownerId === session.userId
      && expectedPending
      && currentPending.token === expectedPending.token;
    const staleOtherOwnerPending = currentPending
      && currentPending.ownerId !== session.userId
      && sameOwnerStillSignedIn;

    if (sameOwnerStillSignedIn && (pendingWasSynced || staleOtherOwnerPending)) {
      await chrome.storage.local.remove(STORAGE_KEYS.pending);
    }

    if (dataChanged && global.document && typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
      global.dispatchEvent(new global.CustomEvent('tabout:quick-links-synced', {
        detail: { count: appData.links.length },
      }));
    }
    return true;
  }

  function updateToolbarStatus(state, message) {
    lastStatus = { state: state, message: message };
    const pageDocument = global.document;
    if (!pageDocument || typeof pageDocument.getElementById !== 'function') return;

    const dot = pageDocument.getElementById('quickLinkSyncStateDot');
    const status = pageDocument.getElementById('cloudSyncStatus');
    const shortText = pageDocument.getElementById('quickLinkSyncButtonLabel');
    if (dot) dot.dataset.state = state === 'ready' ? 'ready' : (state === 'busy' ? 'busy' : (state === 'error' ? 'error' : 'local'));
    if (status) {
      status.dataset.state = state === 'ready' ? 'ready' : (state === 'error' ? 'error' : 'local');
      status.textContent = message;
    }
    if (shortText) {
      shortText.textContent = state === 'busy' ? '同步中' : (state === 'ready' ? '已同步' : (state === 'error' ? '同步异常' : '云同步'));
    }
    const emailNode = pageDocument.getElementById('cloudSyncAccountEmail');
    if (emailNode && state !== 'busy' && !emailNode.textContent) emailNode.textContent = '';
  }

  function showDialog() {
    const dialog = document.getElementById('quickLinkSyncDialog');
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    renderDialogState().catch(function () {});
  }

  function closeDialog() {
    const dialog = document.getElementById('quickLinkSyncDialog');
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function setHidden(id, hidden) {
    const element = document.getElementById(id);
    if (element) element.hidden = hidden;
  }

  async function renderDialogState() {
    const configured = isConfigured();
    const session = await getActiveSession(false);
    setHidden('cloudSyncConfigNotice', configured);
    setHidden('cloudSyncSignedOut', !configured || Boolean(session));
    setHidden('cloudSyncSignedIn', !configured || !session);
    const emailForm = document.getElementById('cloudSyncEmailForm');
    const otpForm = document.getElementById('cloudSyncOtpForm');
    if (emailForm) emailForm.hidden = Boolean(pendingEmail) || Boolean(session) || !configured;
    if (otpForm) otpForm.hidden = !pendingEmail || Boolean(session) || !configured;
    const emailNode = document.getElementById('cloudSyncAccountEmail');
    if (emailNode) emailNode.textContent = session ? session.email : '';
    const pendingEmailNode = document.getElementById('cloudSyncPendingEmail');
    if (pendingEmailNode) pendingEmailNode.textContent = pendingEmail;
    const connectButton = document.getElementById('cloudSyncSendCode');
    if (connectButton) connectButton.textContent = '发送验证码';
    if (!configured) {
      updateToolbarStatus('local', '云同步未配置；当前数据只保存在本地。');
      const notice = document.getElementById('cloudSyncConfigNotice');
      if (notice) notice.innerHTML = '请按仓库 README 的“启用云同步”章节创建 Supabase 项目、执行 SQL migration，并在忽略跟踪的 <strong>extension/config.local.js</strong> 中设置项目 URL 和 Publishable/anon key。不要使用 service_role 或 secret key。';
    } else if (session && lastStatus.state === 'local') {
      updateToolbarStatus('local', '已登录 ' + session.email + '，等待同步。');
    }
  }

  function setBusy(busy) {
    ['cloudSyncSendCode', 'cloudSyncVerifyCode', 'cloudSyncRunNow', 'cloudSyncSignOut'].forEach(function (id) {
      const button = document.getElementById(id);
      if (button) button.disabled = Boolean(busy);
    });
  }

  async function sendOtp(event) {
    if (event) event.preventDefault();
    const emailInput = document.getElementById('cloudSyncEmail');
    const email = String(emailInput && emailInput.value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      updateToolbarStatus('error', '请输入有效的邮箱地址。');
      return;
    }

    setBusy(true);
    try {
      await ensureHostPermission(true);
      await request('/auth/v1/otp', {
        method: 'POST',
        body: { email: email, create_user: true },
      });
      pendingEmail = email;
      updateToolbarStatus('local', '验证码已发送到 ' + email + '。');
      const otpInput = document.getElementById('cloudSyncCode');
      if (otpInput) otpInput.focus();
      await renderDialogState();
    } catch (error) {
      updateToolbarStatus('error', error && error.message ? error.message : '发送验证码失败。');
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp(event) {
    if (event) event.preventDefault();
    const codeInput = document.getElementById('cloudSyncCode');
    const code = String(codeInput && codeInput.value || '').trim();
    if (!pendingEmail || !/^[0-9]{4,10}$/.test(code)) {
      updateToolbarStatus('error', '请输入邮件中的数字验证码。');
      return;
    }

    setBusy(true);
    try {
      await ensureHostPermission(true);
      const result = await request('/auth/v1/verify', {
        method: 'POST',
        body: { email: pendingEmail, token: code, type: 'email' },
      });
      if (!result || !result.access_token || !result.refresh_token || !result.user || !result.user.id) {
        throw new Error('登录响应无效，请确认 Supabase 邮件模板使用一次性验证码。');
      }
      const session = {
        userId: result.user.id,
        email: result.user.email || pendingEmail,
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + Math.max(60, Number(result.expires_in) || 3600) * 1000,
      };
      await storageSet({ [STORAGE_KEYS.session]: session });
      pendingEmail = '';
      startRemotePolling();
      if (codeInput) codeInput.value = '';
      await renderDialogState();
      updateToolbarStatus('busy', '正在合并本地与云端常用标签…');
      await syncNow({ requestPermission: false });
    } catch (error) {
      updateToolbarStatus('error', error && error.message ? error.message : '验证码验证失败。');
    } finally {
      setBusy(false);
      await renderDialogState();
    }
  }

  async function signOut() {
    setBusy(true);
    try {
      const session = await getActiveSession(false);
      if (session && isConfigured() && await hasHostPermission()) {
        await request('/auth/v1/logout', { method: 'POST', token: session.accessToken }).catch(function () {});
      }
      await chrome.storage.local.remove(STORAGE_KEYS.session);
      pendingEmail = '';
      updateToolbarStatus('local', '已退出云同步；本地数据保留。');
      await renderDialogState();
    } finally {
      setBusy(false);
    }
  }

  async function runManualSync() {
    setBusy(true);
    try {
      await ensureHostPermission(true);
      startRemotePolling();
      await syncNow({ requestPermission: false });
    } catch (error) {
      updateToolbarStatus('error', error && error.message ? error.message : '同步失败；本地数据仍然保留。');
    } finally {
      setBusy(false);
      await renderDialogState();
    }
  }

  async function syncNow(options) {
    const settings = options || {};
    if (syncPromise) return syncPromise;
    syncPromise = (async function () {
      if (!isConfigured()) {
        updateToolbarStatus('local', '云同步未配置；当前数据只保存在本地。');
        return { status: 'disabled' };
      }

      const initialSession = await getActiveSession(false);
      if (!initialSession) {
        updateToolbarStatus('local', '登录 Tab Out 账号后即可同步；当前数据只保存在本地。');
        return { status: 'signed-out' };
      }

      if (settings.requestPermission && !(await hasHostPermission())) await ensureHostPermission(true);
      else if (!(await hasHostPermission())) {
        updateToolbarStatus('local', '需要 Supabase 访问权限。打开云同步面板后点击“立即同步”。');
        return { status: 'permission-required' };
      }

      const session = await requireSession();
      updateToolbarStatus('busy', '正在同步常用标签…');

      for (let attempt = 0; attempt < MAX_SYNC_ATTEMPTS; attempt += 1) {
        const snapshot = await getLocalSnapshot(session);
        await storageSet({
          [STORAGE_KEYS.document]: { ownerId: session.userId, document: snapshot.document },
        });

        let row;
        try {
          row = await readRemoteRow(session);
        } catch (error) {
          throw error;
        }

        if (!row) {
          try {
            await insertRemoteRow(session, snapshot.document);
          } catch (error) {
            if (error.status === 409 || error.status === 23505) continue;
            throw error;
          }
          // Re-read the inserted row on the next attempt. This also observes any
          // concurrent write that raced with the first device creating the document.
          continue;
        }

        const merged = mergeDocuments(snapshot.document, row.document);
        if (!sameValue(merged, normalizeDocument(row.document))) {
          const updatedRows = await updateRemoteRow(session, row.revision, merged);
          if (!Array.isArray(updatedRows) || updatedRows.length === 0) continue;
        }

        const activeSession = await getActiveSession(false);
        if (!activeSession || activeSession.userId !== session.userId) {
          throw new Error('Tab Out 账号已切换，请重新同步。');
        }
        const latest = await getLocalSnapshot(session);
        if (!sameValue(latest.document, snapshot.document)) continue;

        if (!(await applyMergedDocument(session, merged, snapshot))) continue;
        retryDelayMs = 3000;
        updateToolbarStatus('ready', '已同步，共 ' + merged.links.length + ' 个常用标签。');
        return { status: 'synced', count: merged.links.length };
      }

      throw new Error('其他设备正在持续修改数据，请稍后再次同步。');
    })().catch(function (error) {
      updateToolbarStatus('error', (error && error.message ? error.message : '同步暂时失败。') + ' 本地修改已保留。');
      scheduleRetry();
      throw error;
    }).finally(function () {
      syncPromise = null;
    });
    return syncPromise;
  }

  function scheduleSync(delay) {
    if (!isConfigured() || syncTimer) return;
    syncTimer = setTimeout(function () {
      syncTimer = null;
      syncNow({ requestPermission: false }).catch(function () {});
    }, Number.isFinite(delay) ? delay : 800);
  }

  function scheduleRetry() {
    if (!isConfigured()) return;
    const delay = retryDelayMs;
    retryDelayMs = Math.min(60000, retryDelayMs * 2);

    // setTimeout is not durable in an MV3 Service Worker. Chrome Alarms wake
    // the worker again after it has been suspended.
    if (!global.document && chrome.alarms && typeof chrome.alarms.create === 'function') {
      try {
        chrome.alarms.create('tab-out-cloud-sync-retry', {
          delayInMinutes: Math.max(0.5, delay / 60000),
        });
      } catch (_) {}
      return;
    }
    scheduleSync(delay);
  }

  async function recordLocalDataChange(appData) {
    if (!isConfigured()) return false;
    const session = await getActiveSession(false);
    if (!session) return false;
    const stored = await storageGet([STORAGE_KEYS.document, STORAGE_KEYS.pending]);
    const previousMeta = stored[STORAGE_KEYS.document];
    const previous = previousMeta && previousMeta.ownerId === session.userId ? previousMeta.document : null;
    const document = buildLocalDocument(appData, previous);
    const pending = {
      ownerId: session.userId,
      token: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2),
      queuedAt: Date.now(),
    };
    await storageSet({
      [STORAGE_KEYS.document]: { ownerId: session.userId, document: document },
      [STORAGE_KEYS.pending]: pending,
    });
    updateToolbarStatus('busy', '本地已保存，正在同步修改…');
    scheduleSync(800);
    return true;
  }

  function wireStorageSyncEvents() {
    if (!chrome.storage?.onChanged?.addListener) return;
    chrome.storage.onChanged.addListener(function (changes, areaName) {
      if (areaName !== 'local') return;
      const marker = changes[STORAGE_KEYS.lastApplied] && changes[STORAGE_KEYS.lastApplied].newValue;
      if (!marker || !marker.nonce) return;
      if (global.__tabOutSyncLastAppliedNonce === marker.nonce) return;
      global.__tabOutSyncLastAppliedNonce = marker.nonce;
      if (global.document && typeof global.dispatchEvent === 'function' && typeof global.CustomEvent === 'function') {
        global.dispatchEvent(new global.CustomEvent('tabout:quick-links-synced', {
          detail: { source: 'background' },
        }));
        updateToolbarStatus('ready', '已从其他 Chrome 配置文件同步更新。');
      }
    });
  }

  function wireUI() {
    const openButton = document.getElementById('quickLinkSyncButton');
    const closeButton = document.getElementById('cloudSyncClose');
    const emailForm = document.getElementById('cloudSyncEmailForm');
    const otpForm = document.getElementById('cloudSyncOtpForm');
    const syncButton = document.getElementById('cloudSyncRunNow');
    const signOutButton = document.getElementById('cloudSyncSignOut');
    if (openButton) openButton.addEventListener('click', showDialog);
    if (closeButton) closeButton.addEventListener('click', closeDialog);
    if (emailForm) emailForm.addEventListener('submit', sendOtp);
    if (otpForm) otpForm.addEventListener('submit', verifyOtp);
    if (syncButton) syncButton.addEventListener('click', runManualSync);
    if (signOutButton) signOutButton.addEventListener('click', function () {
      signOut().catch(function (error) {
        updateToolbarStatus('error', error && error.message ? error.message : '退出登录失败。');
      });
    });
    const resetButton = document.getElementById('cloudSyncChangeEmail');
    if (resetButton) resetButton.addEventListener('click', function () {
      pendingEmail = '';
      renderDialogState().catch(function () {});
    });
    const dialog = document.getElementById('quickLinkSyncDialog');
    if (dialog) dialog.addEventListener('click', function (event) {
      if (event.target === dialog) closeDialog();
    });
  }

  function startRemotePolling() {
    if (!global.document || pollTimer || typeof global.setInterval !== 'function') return;
    pollTimer = global.setInterval(function () {
      if (!isConfigured() || global.document?.visibilityState === 'hidden') return;
      getActiveSession(false).then(function (session) {
        if (session) return syncNow({ requestPermission: false }).catch(function () {});
        return null;
      }).catch(function () {});
    }, 30000);

    if (global.document?.addEventListener) {
      global.document.addEventListener('visibilitychange', function () {
        if (global.document.visibilityState === 'visible') scheduleSync(0);
      });
    }
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('focus', function () { scheduleSync(0); });
    }
  }

  async function initialize() {
    if (initialized) return;
    initialized = true;
    wireUI();
    wireStorageSyncEvents();
    if (!isConfigured()) {
      updateToolbarStatus('local', '云同步未配置；当前数据只保存在本地。');
      return;
    }

    const session = await getActiveSession(false);
    if (!session) {
      updateToolbarStatus('local', '登录 Tab Out 账号后即可在不同 Chrome 配置文件间同步。');
      return;
    }

    if (!(await hasHostPermission())) {
      updateToolbarStatus('local', '已登录 ' + session.email + '；需要打开面板并授权 Supabase 访问。');
      return;
    }

    syncNow({ requestPermission: false }).catch(function () {});
    startRemotePolling();
  }

  global.TabOutCloudSync = {
    isConfigured: isConfigured,
    normalizeDocument: normalizeDocument,
    buildLocalDocument: buildLocalDocument,
    mergeDocuments: mergeDocuments,
    toQuickLinkData: toQuickLinkData,
    recordLocalDataChange: recordLocalDataChange,
    syncNow: syncNow,
    initialize: initialize,
    openDialog: showDialog,
  };
})(globalThis);
