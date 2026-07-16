(() => {
  'use strict';

  const CATEGORY_COLORS = Object.freeze({
    'AI': '#4f7df3',
    '开发': '#159b96',
    '翻译': '#2f9b68',
    '娱乐': '#d95f91',
    '设计': '#8266c9',
    '效率': '#c77b2b',
    '搜索': '#3977c5',
    '社交': '#4c7f90',
    '购物': '#c06b45',
    '新闻': '#b15e61',
    '文档': '#65758b',
    '常用': '#65758b',
    '其他': '#70757d',
  });

  const SERVICE_CATEGORY_LABELS = Object.freeze({
    'AI Tools': 'AI',
    Video: '娱乐',
    Development: '开发',
    Search: '搜索',
    Social: '社交',
    Shopping: '购物',
    News: '新闻',
    Documents: '文档',
    Productivity: '效率',
    Other: '其他',
  });

  const CATEGORY_DESCRIPTIONS = Object.freeze({
    'AI': 'AI 智能工具',
    '开发': '开发与技术工具',
    '翻译': '在线翻译工具',
    '娱乐': '影音与内容社区',
    '设计': '设计与创意工具',
    '效率': '效率与协作工具',
    '搜索': '搜索与信息发现',
    '社交': '社交与社区平台',
    '购物': '在线购物平台',
    '新闻': '资讯与行业动态',
    '文档': '文档与知识管理',
    '常用': '常用网站',
    '其他': '网站快捷入口',
  });

  function cleanText(value, maxLength) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength);
  }

  function sanitizeColor(value, fallback = CATEGORY_COLORS['其他']) {
    const color = String(value || '').trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color.toLowerCase() : fallback;
  }

  function getCategoryColor(category) {
    return CATEGORY_COLORS[category] || CATEGORY_COLORS['其他'];
  }

  function mapServiceCategory(category) {
    return SERVICE_CATEGORY_LABELS[category] || '其他';
  }

  function parseFavoriteUrl(rawUrl) {
    try {
      return new URL(String(rawUrl || ''));
    } catch {
      return null;
    }
  }

  function inferKnownSite(url, title = '') {
    const parsed = parseFavoriteUrl(url);
    const hostname = parsed?.hostname.toLowerCase().replace(/^www\./, '') || '';
    const path = parsed?.pathname.toLowerCase() || '';
    const titleText = cleanText(title, 120).toLowerCase();
    const signal = `${hostname} ${path} ${titleText}`;

    if (
      hostname === 'platform.deepseek.com' ||
      hostname === 'api-docs.deepseek.com' ||
      (hostname.endsWith('deepseek.com') && /platform|api|开放平台|开发平台/.test(signal))
    ) {
      return { description: 'API 服务平台', category: '开发', badge: 'API', color: '#6d5ef8' };
    }
    if (hostname.endsWith('deepseek.com')) {
      return { description: 'AI 对话助手', category: 'AI', badge: '官方', color: '#4f7df3' };
    }
    if (hostname === 'chatgpt.com' || hostname === 'chat.openai.com') {
      return { description: 'AI 对话与创作助手', category: 'AI', badge: 'AI', color: '#2f8f75' };
    }
    if (hostname === 'claude.ai') {
      return { description: 'AI 对话与分析助手', category: 'AI', badge: 'AI', color: '#b06f45' };
    }
    if (hostname === 'gemini.google.com') {
      return { description: 'Google AI 助手', category: 'AI', badge: 'AI', color: '#4f7df3' };
    }
    if (hostname === 'perplexity.ai') {
      return { description: 'AI 搜索与研究工具', category: 'AI', badge: 'AI', color: '#159b96' };
    }
    if (hostname === 'github.com' || hostname.endsWith('.github.com')) {
      return { description: '代码托管与协作平台', category: '开发', badge: 'Git', color: '#65758b' };
    }
    if (hostname === 'gitlab.com') {
      return { description: 'DevOps 与代码协作平台', category: '开发', badge: 'Git', color: '#d36b43' };
    }
    if (hostname === 'stackoverflow.com') {
      return { description: '开发者问答社区', category: '开发', badge: '社区', color: '#c77b2b' };
    }
    if (hostname === 'vercel.com') {
      return { description: '前端部署与云平台', category: '开发', badge: 'Cloud', color: '#65758b' };
    }
    if (hostname === 'translate.google.com' || hostname === 'translate.google.cn') {
      return { description: 'Google 在线翻译工具', category: '翻译', badge: '翻译', color: '#3977c5' };
    }
    if (hostname === 'fanyi.baidu.com' || hostname === 'fanyi.youdao.com') {
      return { description: '在线翻译与词典', category: '翻译', badge: '翻译', color: '#2f9b68' };
    }
    if (hostname === 'bilibili.com' || hostname.endsWith('.bilibili.com')) {
      return { description: '视频与兴趣内容社区', category: '娱乐', badge: '视频', color: '#d95f91' };
    }
    if (hostname === 'youtube.com' || hostname.endsWith('.youtube.com')) {
      return { description: '在线视频与创作者平台', category: '娱乐', badge: '视频', color: '#c94c55' };
    }
    if (hostname === 'figma.com' || hostname.endsWith('.figma.com')) {
      return { description: '协作式界面设计工具', category: '设计', badge: '设计', color: '#8266c9' };
    }
    if (hostname === 'notion.so' || hostname.endsWith('.notion.so')) {
      return { description: '文档与知识管理工具', category: '文档', badge: '效率', color: '#65758b' };
    }
    if (hostname === 'docs.google.com') {
      return { description: '在线文档协作工具', category: '文档', badge: '文档', color: '#3977c5' };
    }
    if (hostname === 'linear.app') {
      return { description: '产品与研发协作工具', category: '效率', badge: '效率', color: '#6d5ef8' };
    }
    if (hostname === 'google.com' || hostname === 'google.cn') {
      return { description: '网页与信息搜索', category: '搜索', badge: '搜索', color: '#3977c5' };
    }
    if (hostname === 'baidu.com' || hostname.endsWith('.baidu.com')) {
      return { description: '中文信息与网页搜索', category: '搜索', badge: '搜索', color: '#4f7df3' };
    }
    if (hostname === 'x.com' || hostname === 'twitter.com') {
      return { description: '实时信息与社交平台', category: '社交', badge: '社交', color: '#65758b' };
    }
    if (hostname === 'reddit.com' || hostname.endsWith('.reddit.com')) {
      return { description: '兴趣讨论与社区平台', category: '社交', badge: '社区', color: '#d36b43' };
    }
    if (hostname === 'amazon.com' || hostname.endsWith('.amazon.com')) {
      return { description: '综合在线购物平台', category: '购物', badge: '购物', color: '#c77b2b' };
    }
    if (hostname === 'taobao.com' || hostname.endsWith('.taobao.com')) {
      return { description: '综合在线购物平台', category: '购物', badge: '购物', color: '#d36b43' };
    }
    if (hostname === 'news.ycombinator.com') {
      return { description: '科技创业资讯社区', category: '新闻', badge: '资讯', color: '#c77b2b' };
    }

    if (/api|developer|docs?\//.test(signal)) {
      return { description: '开发文档与服务平台', category: '开发', badge: 'API', color: getCategoryColor('开发') };
    }
    return null;
  }

  function inferFavoriteMetadata({ url, title, groupName = '常用' }) {
    const known = inferKnownSite(url, title);
    const category = cleanText(groupName, 30) || '常用';
    return {
      description: known?.description || CATEGORY_DESCRIPTIONS[category] || CATEGORY_DESCRIPTIONS['其他'],
      category,
      badge: known?.badge || '',
      color: known?.color || getCategoryColor(category),
      recommendedCategory: known?.category || '',
    };
  }

  function enrichFavorite(link, groupName = '常用') {
    const inferred = inferFavoriteMetadata({ url: link.url, title: link.title, groupName });
    const custom = link.metadataSource === 'custom';
    const groupCategory = cleanText(groupName, 30) || '常用';
    const previousStatus = ['available', 'dismissed', 'accepted', 'none'].includes(link.suggestionStatus)
      ? link.suggestionStatus
      : '';
    const localSuggestion = inferred.recommendedCategory && inferred.recommendedCategory !== groupCategory
      ? inferred.recommendedCategory
      : '';
    const suggestionStatus = previousStatus || (localSuggestion ? 'available' : '');

    return {
      ...link,
      title: cleanText(link.title, 80),
      description: custom
        ? cleanText(link.description, 100)
        : cleanText(link.description, 100) || inferred.description,
      favicon: cleanText(link.favicon, 500),
      category: groupCategory,
      badge: custom ? cleanText(link.badge, 16) : cleanText(link.badge, 16) || inferred.badge,
      color: sanitizeColor(link.color, inferred.color),
      metadataSource: custom ? 'custom' : 'auto',
      suggestedCategory: cleanText(link.suggestedCategory, 30) || localSuggestion,
      suggestionStatus,
      suggestionCheckedAt: link.suggestionCheckedAt || '',
    };
  }

  globalThis.TabOutFavoritesMetadata = Object.freeze({
    CATEGORY_COLORS,
    cleanText,
    enrichFavorite,
    getCategoryColor,
    inferFavoriteMetadata,
    mapServiceCategory,
    sanitizeColor,
  });
})();
