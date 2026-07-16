(() => {
  'use strict';

  const categoryConfig = globalThis.TabOutSiteCategories || {};
  const categories = categoryConfig.CATEGORIES || ['Other'];
  const validCategories = new Set(categories);
  const rules = categoryConfig.RULES || {};
  const otherCategory = categoryConfig.OTHER_CATEGORY || 'Other';
  const cache = globalThis.TabOutCategoryCache;
  const ruleEntries = Object.entries(rules).sort((a, b) => b[0].length - a[0].length);
  const memoryCache = new Map();
  const inFlightRequests = new Map();

  function normalizeHostname(hostname) {
    return String(hostname || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
  }

  function getRuleCategory(hostname) {
    for (const [ruleHostname, category] of ruleEntries) {
      if (hostname === ruleHostname || hostname.endsWith(`.${ruleHostname}`)) return category;
    }
    return null;
  }

  function getDeepSeekApiKey() {
    return String(globalThis.DEEPSEEK_API_KEY || '').trim();
  }

  function getDeepSeekModel() {
    return String(globalThis.DEEPSEEK_MODEL || 'deepseek-chat').trim();
  }

  function buildPrompt(hostname) {
    return `你是网站分类助手。

请根据下面网站的域名判断它属于哪个类别。

只能返回下面之一：

AI Tools
Video
Development
Search
Social
Shopping
News
Documents
Productivity
Other

域名：

${hostname}

只返回类别名称，不要解释。`;
  }

  function normalizeCategory(value) {
    const normalized = String(value || '')
      .trim()
      .replace(/^```(?:text)?\s*/i, '')
      .replace(/```$/i, '')
      .replace(/^["'`]+|["'`。]+$/g, '')
      .trim();
    return validCategories.has(normalized) ? normalized : null;
  }

  async function requestDeepSeek(hostname, apiKey) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: getDeepSeekModel(),
          messages: [{ role: 'user', content: buildPrompt(hostname) }],
          temperature: 0,
          max_tokens: 16,
          stream: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) throw new Error(`DeepSeek request failed with status ${response.status}`);
      const payload = await response.json();
      return normalizeCategory(payload?.choices?.[0]?.message?.content);
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async function resolveCategory(hostname) {
    const cached = await cache?.get(hostname);
    const cachedCategory = normalizeCategory(cached?.category);
    if (cachedCategory) {
      memoryCache.set(hostname, cachedCategory);
      return cachedCategory;
    }

    const apiKey = getDeepSeekApiKey();
    if (!apiKey) return otherCategory;

    try {
      const category = await requestDeepSeek(hostname, apiKey);
      if (!category) return otherCategory;
      memoryCache.set(hostname, category);
      await cache?.set(hostname, category);
      return category;
    } catch (error) {
      console.warn(`[tab-out] Could not classify ${hostname}:`, error);
      return otherCategory;
    }
  }

  async function getCategory(hostname) {
    const normalizedHostname = normalizeHostname(hostname);
    if (!normalizedHostname) return otherCategory;

    const ruleCategory = getRuleCategory(normalizedHostname);
    if (ruleCategory) return ruleCategory;
    if (memoryCache.has(normalizedHostname)) return memoryCache.get(normalizedHostname);
    if (inFlightRequests.has(normalizedHostname)) return inFlightRequests.get(normalizedHostname);

    const request = resolveCategory(normalizedHostname)
      .finally(() => inFlightRequests.delete(normalizedHostname));
    inFlightRequests.set(normalizedHostname, request);
    return request;
  }

  async function getCategories(hostnames, concurrency = 3) {
    const queue = [...new Set((hostnames || []).map(normalizeHostname).filter(Boolean))];
    const results = new Map();
    let cursor = 0;

    async function worker() {
      while (cursor < queue.length) {
        const hostname = queue[cursor];
        cursor += 1;
        results.set(hostname, await getCategory(hostname));
      }
    }

    const workerCount = Math.min(Math.max(1, concurrency), queue.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  async function clearCache() {
    memoryCache.clear();
    return cache?.clear() || false;
  }

  globalThis.TabOutCategoryService = Object.freeze({
    getCategory,
    getCategories,
    clearCache,
  });
})();
