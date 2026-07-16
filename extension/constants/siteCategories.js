(() => {
  'use strict';

  const CATEGORIES = Object.freeze([
    'AI Tools',
    'Video',
    'Development',
    'Search',
    'Social',
    'Shopping',
    'News',
    'Documents',
    'Productivity',
    'Other',
  ]);

  const CATEGORY_LABELS = Object.freeze({
    'AI Tools': 'AI 工具',
    Video: '视频',
    Development: '开发',
    Search: '搜索',
    Social: '社交',
    Shopping: '购物',
    News: '新闻',
    Documents: '文档',
    Productivity: '效率工具',
    Other: '其他',
  });

  const RULES = Object.freeze({
    // AI tools
    'chatgpt.com': 'AI Tools',
    'chat.openai.com': 'AI Tools',
    'openai.com': 'AI Tools',
    'claude.ai': 'AI Tools',
    'gemini.google.com': 'AI Tools',
    'deepseek.com': 'AI Tools',
    'perplexity.ai': 'AI Tools',
    'cursor.com': 'AI Tools',
    'cursor.sh': 'AI Tools',
    'poe.com': 'AI Tools',
    'copilot.microsoft.com': 'AI Tools',
    'huggingface.co': 'AI Tools',

    // Video
    'youtube.com': 'Video',
    'bilibili.com': 'Video',
    'iqiyi.com': 'Video',
    'v.qq.com': 'Video',
    'netflix.com': 'Video',
    'youku.com': 'Video',
    'mgtv.com': 'Video',
    'douyin.com': 'Video',
    'vimeo.com': 'Video',

    // Development
    'github.com': 'Development',
    'gist.github.com': 'Development',
    'gitlab.com': 'Development',
    'stackoverflow.com': 'Development',
    'vercel.com': 'Development',
    'cloudflare.com': 'Development',
    'npmjs.com': 'Development',
    'developer.mozilla.org': 'Development',
    'codepen.io': 'Development',
    'leetcode.com': 'Development',
    'gitee.com': 'Development',

    // Search
    'google.com': 'Search',
    'bing.com': 'Search',
    'baidu.com': 'Search',
    'duckduckgo.com': 'Search',
    'sogou.com': 'Search',

    // Social
    'x.com': 'Social',
    'twitter.com': 'Social',
    'reddit.com': 'Social',
    'facebook.com': 'Social',
    'discord.com': 'Social',
    'telegram.org': 'Social',
    'linkedin.com': 'Social',
    'weibo.com': 'Social',

    // Shopping
    'amazon.com': 'Shopping',
    'amazon.cn': 'Shopping',
    'taobao.com': 'Shopping',
    'tmall.com': 'Shopping',
    'jd.com': 'Shopping',
    'pinduoduo.com': 'Shopping',
    'yangkeduo.com': 'Shopping',
    '1688.com': 'Shopping',

    // News and reading
    'news.ycombinator.com': 'News',
    'sspai.com': 'News',
    'juejin.cn': 'News',
    'infoq.com': 'News',
    '36kr.com': 'News',
    'zhihu.com': 'News',
    'medium.com': 'News',
    'substack.com': 'News',

    // Documents
    'notion.so': 'Documents',
    'larksuite.com': 'Documents',
    'feishu.cn': 'Documents',
    'docs.google.com': 'Documents',
    'drive.google.com': 'Documents',
    'docs.qq.com': 'Documents',
    'shimo.im': 'Documents',
    'yuque.com': 'Documents',
    'office.com': 'Documents',

    // Productivity
    'jira.com': 'Productivity',
    'atlassian.net': 'Productivity',
    'linear.app': 'Productivity',
    'trello.com': 'Productivity',
    'asana.com': 'Productivity',
    'slack.com': 'Productivity',
    'mail.google.com': 'Productivity',
    'calendar.google.com': 'Productivity',
    'meet.google.com': 'Productivity',
    'clickup.com': 'Productivity',
    'monday.com': 'Productivity',
  });

  globalThis.TabOutSiteCategories = Object.freeze({
    CATEGORIES,
    CATEGORY_LABELS,
    RULES,
    OTHER_CATEGORY: 'Other',
  });
})();
