# 05: 分组偏好存储

Status: Done

对应规格：R5（spec.md）

## 目标

建立"域名→分组"的用户偏好本地存储，为智能推荐（06）提供数据基础，并提供清除入口。

## 范围

- 新模块 `extension/services/groupPreferenceService.js`（IIFE，挂 `globalThis.TabOutGroupPreferenceService`）：
  - 存储 key：`tabOutGroupPreferences`，结构 `{ [hostname]: { groupName, updatedAt } }`，存 `chrome.storage.local`
  - `normalizeHostname(url|hostname)`：去 `www.`、小写；无法解析返回 ''
  - `record(hostname, groupName)`：写入/更新并 LRU 淘汰（上限 200，按 updatedAt 最旧先删）
  - `get(hostname)` → `{ groupName, updatedAt } | null`
  - `getAll()`、`clear()`
  - 模块需可在 node --test 环境加载（chrome.storage 由测试注入 stub，参考 tests/cloud-sync.test.js 模式）
- `extension/app.js` 记录时机接线（全部记录最终选择）：
  1. Dialog 提交成功（add/update）
  2. `addPickerTabToGroup` 成功
  3. `updateQuickLink` 分组变化
  4. `acceptFavoriteSuggestion` 成功
- `extension/index.html`：`.favorites-toolbar` 新增"清除分组偏好"图标按钮（`data-action="clear-group-preferences"`）
- `extension/app.js`：对应 action → `clear()` + toast"已清除分组偏好记录"

## 验收标准

1. 通过任一入口添加/移动常用标签后，`chrome.storage.local` 中 `tabOutGroupPreferences` 出现该 hostname 记录
2. 同一 hostname 重复记录覆盖旧值并刷新 updatedAt
3. 超过 200 条时最旧记录被淘汰（单测验证）
4. hostname 归一化：`https://WWW.Example.com/x` 与 `example.com` 记录到同一 key
5. 点击"清除分组偏好"→ 记录清空 + toast 确认
6. 偏好数据不出现在云同步 payload、不写 IndexedDB
7. 单测覆盖 record/get/LRU/normalize/clear，`npm test` 通过

## 阻塞关系

- Blocks: 06
- Blocked by: 无（Phase 3 起点）

## Comments

- 2026-10-28: 实现完成，8 项单测通过（tests/group-preference.test.js）。数据通路选择：页面侧直接读写 chrome.storage.local（单一通路，未经 backgroundClient 转发）；模块未加入 background.js importScripts——偏好仅在页面上下文使用。
- 2026-10-28（评审跟进）: 已知规格空白——拖拽移动分组（moveQuickLink）不记录偏好，四个记录时机枚举未含拖拽；如需补齐约为 3 行改动（moveQuickLink 跨组时调用 recordGroupPreference），留待用户决定。已同步记录到 spec.md 修订记录第 6 条。
