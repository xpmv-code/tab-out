/**
 * Tab Out timeline search.
 *
 * Filters the browsing timeline by query tokens across titles, hostnames
 * and URLs, and produces paginated results with match reasons.
 */
"use strict";
(() => {
  function normalizeTokens(query) {
    return String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  }
  function getRecordHostname(record) {
    if (record?.hostname) return String(record.hostname).replace(/^www\./, "").toLowerCase();
    try {
      return new URL(record?.url || "").hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      return "";
    }
  }
  function decodeUrl(url) {
    try {
      return decodeURIComponent(String(url || ""));
    } catch {
      return String(url || "");
    }
  }
  function createUrlHint(url, requiredTokens) {
    const readableUrl = decodeUrl(url).replace(/^https?:\/\/(?:www\.)?/i, "");
    const normalizedUrl = readableUrl.toLowerCase();
    const firstIndex = requiredTokens.reduce((earliest, token) => {
      const index = normalizedUrl.indexOf(token);
      if (index < 0) return earliest;
      return earliest < 0 ? index : Math.min(earliest, index);
    }, -1);
    if (firstIndex < 0 || readableUrl.length <= 100) return readableUrl;
    const start = Math.max(0, firstIndex - 32);
    const end = Math.min(readableUrl.length, start + 100);
    return `${start > 0 ? "\u2026" : ""}${readableUrl.slice(start, end)}${end < readableUrl.length ? "\u2026" : ""}`;
  }
  function getRecordMatch(record, tokens) {
    const values = {
      title: String(record?.title || "").toLowerCase(),
      hostname: getRecordHostname(record),
      url: `${String(record?.url || "")} ${decodeUrl(record?.url)}`.toLowerCase()
    };
    if (!tokens.every((token) => Object.values(values).some((value) => value.includes(token)))) {
      return null;
    }
    const matchedFields = Object.entries(values).filter(([, value]) => tokens.some((token) => value.includes(token))).map(([field]) => field);
    const urlOnlyTokens = tokens.filter(
      (token) => !values.title.includes(token) && !values.hostname.includes(token) && values.url.includes(token)
    );
    return {
      isMatch: true,
      isContext: false,
      matchedFields,
      tokens: [...tokens],
      urlHint: urlOnlyTokens.length > 0 ? createUrlHint(record?.url, urlOnlyTokens) : ""
    };
  }
  function filterTabTree(nodes, tokens) {
    const filtered = [];
    let matchCount = 0;
    for (const node of nodes || []) {
      const childrenResult = filterTabTree(node.children, tokens);
      const match = getRecordMatch(node, tokens);
      const isMatch = Boolean(match);
      if (!isMatch && childrenResult.nodes.length === 0) continue;
      if (isMatch) matchCount += 1;
      matchCount += childrenResult.matchCount;
      filtered.push({
        ...node,
        children: childrenResult.nodes,
        searchMatch: match || {
          isMatch: false,
          isContext: true,
          matchedFields: [],
          tokens: [...tokens],
          urlHint: ""
        }
      });
    }
    return { nodes: filtered, matchCount };
  }
  function filterSessions(blocks, tokens) {
    const filtered = [];
    let matchCount = 0;
    for (const block of blocks || []) {
      const records = [];
      for (const record of block.records || []) {
        const match = getRecordMatch(record, tokens);
        if (match) records.push({ ...record, searchMatch: match });
      }
      if (records.length === 0) continue;
      matchCount += records.length;
      filtered.push({
        ...block,
        records,
        recordCount: records.length
      });
    }
    return { blocks: filtered, matchCount };
  }
  function paginateTabTree(nodes, pageState) {
    const paginated = [];
    for (const node of nodes || []) {
      if (pageState.remaining <= 0) break;
      const includeSelf = node.searchMatch?.isMatch && pageState.remaining > 0;
      if (includeSelf) {
        pageState.remaining -= 1;
        pageState.displayed += 1;
      }
      const children = paginateTabTree(node.children, pageState);
      if (!includeSelf && children.length === 0) continue;
      paginated.push({ ...node, children });
    }
    return paginated;
  }
  function paginateSessions(blocks, pageState) {
    const paginated = [];
    for (const block of blocks || []) {
      if (pageState.remaining <= 0) break;
      const records = block.records.slice(0, pageState.remaining);
      if (records.length === 0) continue;
      pageState.remaining -= records.length;
      pageState.displayed += records.length;
      paginated.push({ ...block, records, recordCount: records.length });
    }
    return paginated;
  }
  function searchTimeline(snapshot, query, options = {}) {
    const tokens = normalizeTokens(query);
    const treeResult = filterTabTree(snapshot?.tabTree, tokens);
    const sessionResult = filterSessions(snapshot?.sessions?.blocks, tokens);
    const totalMatches = treeResult.matchCount + sessionResult.matchCount;
    const requestedLimit = Number(options.limit);
    const limit = Number.isFinite(requestedLimit) ? Math.max(0, Math.trunc(requestedLimit)) : totalMatches;
    const pageState = { remaining: limit, displayed: 0 };
    const tabTree = paginateTabTree(treeResult.nodes, pageState);
    const sessionBlocks = paginateSessions(sessionResult.blocks, pageState);
    return {
      active: tokens.length > 0,
      query: String(query || ""),
      tokens,
      tabTree,
      sessions: {
        ...snapshot?.sessions || {},
        blocks: sessionBlocks
      },
      stats: {
        totalMatches,
        displayedMatches: pageState.displayed,
        hiddenMatches: totalMatches - pageState.displayed,
        tabMatches: treeResult.matchCount,
        historyMatches: sessionResult.matchCount,
        matchingSessions: sessionResult.blocks.length
      },
      limit
    };
  }
  globalThis.TabOutTimelineSearch = Object.freeze({ searchTimeline });
})();
