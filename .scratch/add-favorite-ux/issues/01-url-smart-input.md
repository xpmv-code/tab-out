# 01: URL 智能输入（datalist + 粘贴清理）

Status: Done

对应规格：R2（spec.md）

## 目标

Dialog 表单的 URL 输入框获得候选补全与粘贴自动清理，减少手动输入摩擦。

## 范围

- `extension/index.html`：为 `#quickLinkUrl` 增加 `list` 属性 + `<datalist id="quickLinkUrlSuggestions">`
- `extension/app.js`：
  - 新函数 `buildUrlSuggestions()`：合并 `chrome.tabs.query({})` 打开标签与 `chrome.history.search({ text: '', maxResults: 100 })`，按 URL 去重（标签页优先），过滤非 http/https 协议，返回 `{ url, title }` 列表（上限约 100 条）
  - `showQuickLinkForm` 打开时异步填充 datalist（不阻塞 Dialog 显示）
  - 新函数 `cleanPastedUrl(text)`：trim + 去除 `utm_*`、`fbclid`、`gclid`、`ref`、`ref_src` 等追踪参数，清理悬空 `?`；无法解析为 URL 时原样返回 trim 结果
  - `#quickLinkUrl` 的 `paste` 事件处理：用清理后的值替换默认粘贴
- 纯逻辑 `cleanPastedUrl` 抽到可独立加载的位置以便测试（放 `extension/favorites/favorites-metadata.js` 之外的新工具或 app.js 内可导出——实现时按 tests/ 现有加载模式决定）

## 验收标准

1. 打开"添加网站" Dialog，聚焦 URL 输入框可见候选（打开标签 + 历史）
2. 粘贴 `https://a.com/p?utm_source=x&id=1` → 输入框得到 `https://a.com/p?id=1`
3. 粘贴 `https://a.com/p?utm_source=x` → 得到 `https://a.com/p`（无悬空 `?`）
4. 粘贴非 URL 文本不被破坏（仅 trim）
5. `chrome.history` 不可用/为空时 datalist 仅含标签页候选，无报错
6. 新增单测覆盖 `cleanPastedUrl` 各分支，`npm test` 通过

## 阻塞关系

- Blocks: 无
- Blocked by: 无

## Comments
