# 03: 设置页内容迁移 + 工具栏清理

Status: Done

对应规格：R3 + R4（spec.md）

## 目标

导入/导出/清除偏好移入设置页并可用；云同步区、分类缓存清理、DeepSeek 状态就位；工具栏精简为 4 按钮。

## 范围

- `extension/index.html`：
  - 常用标签数据区：导入按钮（`data-action="import-quick-links"`）、导出按钮（`data-action="export-quick-links"`）、清除分组偏好按钮（`data-action="clear-group-preferences"`）+ 条数展示 span；`#quickLinkImportInput` file input 移入设置页（保持 hidden）
  - 云同步区：状态行（`#settingsSyncStatus`）+ "云同步设置"按钮（`data-action="open-cloud-sync-settings"`）
  - 网站分类区：DeepSeek 状态行（`#settingsDeepseekStatus`）+ "清除分类缓存"按钮（`data-action="clear-category-cache"`）
  - **工具栏移除**：导入/导出/清除偏好三个按钮（`.favorites-toolbar` 剩：云同步/添加/编辑/删除）
- `extension/app.js`：
  - `open-cloud-sync-settings` action → `document.getElementById('quickLinkSyncButton')?.click()`（代理复用 cloudSync.js 绑定，不复制逻辑）
  - `clear-category-cache` action → `TabOutBackgroundClient.clearCategoryCache()` + toast（失败静默降级提示）
  - `renderSettingsView()` 扩展：刷新偏好条数（`TabOutGroupPreferenceService.getAll()`）、云同步状态文字（读 `chrome.storage.local` 的 tabOutSyncSession，与 cloudSync 状态点同源）、DeepSeek 状态（`globalThis.DEEPSEEK_API_KEY` 有无 + `DEEPSEEK_MODEL`）
- `README.md`：隐私表加"主题偏好 → localStorage → 否"行（R4）
- 既有 action 处理器（import/export/clear-group-preferences）零改动复用——仅按钮换位置

## 验收标准

1. 设置页导入：文件选择器打开，导入成功 toast + 常用标签刷新（与迁移前一致）
2. 设置页导出/清除偏好可用；清除后条数展示归零
3. "云同步设置"打开既有同步 dialog；工具栏云同步按钮与状态点仍正常（cloudSync.js 绑定不受影响）
4. 清除分类缓存 toast 确认；SW 不可用时静默降级不报错
5. DeepSeek 状态行：配置 config.local.js 有 key 显示"已配置（模型名）"，无 key 显示"未配置——分类由内置规则处理"
6. 工具栏恰好 4 按钮：云同步/添加/编辑/删除
7. 全量测试 + `npm run verify` 通过

## 阻塞关系

- Blocks: 无
- Blocked by: 01（与 02 可并行）

## Comments

- 2026-10-28: 实现完成。评审跟进修复：① `open-cloud-sync-settings` 从 `.click()` 代理改为 cloudSync.js 新导出的 `TabOutCloudSync.openDialog()` 直调（消除对工具栏按钮存在的隐式依赖）；② `clear-category-cache` 增加 client 缺失守卫，避免可选链静默 resolve 造成假成功 toast；③ 设置页副标题限定为"本页的主题、分组偏好与分类缓存仅保存在本机"（原文案与云同步隐私表述冲突）；④ 两处 `renderSettingsView()` 补 await；⑤ 删除未引用的 `.settings-status-value` 死样式。修复后 `npm run verify` 通过（50/50）。
