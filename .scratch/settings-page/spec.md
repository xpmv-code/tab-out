# Spec: 设置页面与设置入口（settings-page）

Status: Approved（用户已在 grilling 中确认全部决策）

## 背景

全局性功能（导入导出、云同步、清除分组偏好）目前挤在常用标签工具栏一行 7 个按钮里；深色模式纯靠 CSS `prefers-color-scheme` 自动切换，无手动控制。需要一个独立设置页面与并列入口，收拢全局设置项并补齐主题切换。

## 目标

1. 视图切换器新增第三个并列入口"设置"（标签看板 | 时间线 | 设置）
2. 设置页收拢：导入/导出、清除分组偏好、云同步入口、浅色/深色/跟随系统三态主题切换
3. 常用标签工具栏精简（云同步按钮保留）

## 已确认决策（grilling）

1. **工具栏处置**：导入/导出/清除偏好从常用标签工具栏**移除**（移入设置页）；**云同步按钮保留在工具栏**（状态圆点常驻可见）；工具栏剩：云同步/添加/编辑/删除
2. **主题形式**：**三态**——跟随系统（默认）/浅色/深色；持久化，重开浏览器仍生效
3. **附加项**：设置页加"清除网站分类缓存"按钮（复用 `TabOutBackgroundClient.clearCategoryCache`）+ DeepSeek 配置状态只读展示（已配置/未配置）

## 需求明细

### R1 设置视图骨架

- 视图切换器（`.view-switcher`）新增第三个 `role="tab"` 按钮：齿轮图标 + "设置"，`data-view="settings"`，`aria-controls="settingsView"`
- 新增 `<main class="app-view settings-view dashboard-panel" id="settingsView" role="tabpanel" hidden>`，位于 timelineView 之后
- `setAppView` 改三态：`dashboard | timeline | settings`；分组方式控件仅在 dashboard 显示；切到 settings 时调用 `renderSettingsView()` 刷新状态类内容
- 设置页分区（复用现有 panel/card 视觉语言）：**外观**、**常用标签页数据**、**云同步**、**网站分类**
- 从其他视图跳转逻辑兼容：`revealQuickLink` 等已按 `activeAppView !== 'dashboard'` 判断，settings 视图下同样先切回 dashboard

### R2 主题三态切换

- **机制**：`<html data-theme="light|dark">`；新文件 `extension/theme.js` 在 `<head>` 同步加载（MV3 CSP 禁内联脚本），首帧前读取本地存储的模式并解析系统偏好，立即设置 `data-theme`，零闪烁
- **模式持久化**：`localStorage['tabOutThemeMode']` = `system | light | dark`（默认 `system`）。选 localStorage 而非 chrome.storage.local 是因其**同步可读**，避免异步读取导致的主题闪烁；仍为纯本地数据
- **CSS 改造**：`base.css` 与 `favorites.css` 中的 `@media (prefers-color-scheme: dark)` 变量块改为 `:root[data-theme="dark"]` 选择器（单一来源，不复制变量）；系统偏好变化由 JS 监听 `matchMedia` 在 system 模式下重新解析
- **设置页外观区**：三分段控件（跟随系统/浅色/深色），`data-action="set-theme"` + `data-theme-mode`，当前模式 `aria-pressed`；切换立即生效并持久化
- `theme.js` 暴露 `globalThis.TabOutTheme`（getMode/setMode/resolveMode），纯逻辑可单测

### R3 设置页内容

- **常用标签页数据区**：
  - 导入（触发既有 `#quickLinkImportInput`，file input 移入设置页）、导出（复用 `export-quick-links` action）
  - 清除分组偏好（复用 `clear-group-preferences` action，显示当前记录条数）
- **云同步区**：状态文字（本地/已登录，读取现有同步状态）+ "云同步设置"按钮（代理点击工具栏 `#quickLinkSyncButton`，复用 cloudSync.js 既有 dialog，不复制逻辑）
- **网站分类区**：DeepSeek 配置状态只读行（`globalThis.DEEPSEEK_API_KEY` 是否存在 + 模型名）；"清除分类缓存"按钮 → `TabOutBackgroundClient.clearCategoryCache()` + toast；未配置 DeepSeek 时说明"分类由内置规则处理"
- **工具栏清理**：移除 `.favorites-toolbar` 中的导入/导出/清除偏好三个按钮；云同步/添加/编辑/删除保留

### R4 文档

- README"数据与隐私"表新增：主题偏好 → localStorage → 否
- CONTEXT.md 无需新术语（设置页为 UI 概念，非领域概念）

## 验收标准

1. 视图切换器三个入口并列：标签看板 | 时间线 | 设置；切换正常，分组方式控件仅看板显示
2. 设置页四区齐全：外观/常用标签页数据/云同步/网站分类
3. 主题三态切换立即生效、刷新后保持；system 模式下随系统偏好实时切换；无首帧闪烁
4. 导入/导出/清除偏好在设置页可用；工具栏中三按钮已移除；云同步按钮仍在工具栏且状态点正常
5. 清除分类缓存按钮工作（toast 确认）；DeepSeek 状态行正确反映配置
6. 常用标签工具栏剩 4 按钮：云同步/添加/编辑/删除
7. `npm run verify` 通过；theme.js 纯逻辑（resolveMode/setMode 持久化）有 node --test 单测
8. 云同步既有流程（cloudSync.js 绑定 `#quickLinkSyncButton`）不受按钮迁移影响

## 技术要点

- `theme.js` 为经典脚本置于 `<head>`（style.css 之后、body 之前均可，须在首帧前执行）；`index.html` 需同步引入
- CSS 改造只动两个 `@media (prefers-color-scheme: dark)` 块的选择器包裹方式，变量内容不动；`color-scheme` 属性随块迁移
- `renderSettingsView()` 必须全部 null-safe（VM 测试 document stub 返回 null）
- dist 构建自动收录新 JS 文件（build.mjs 递归收集），无需改构建脚本

## 里程碑

- Ticket 01：设置视图骨架（阻塞 02/03）
- Ticket 02：主题三态（依赖 01）
- Ticket 03：内容迁移 + 工具栏清理（依赖 01）

每个 ticket 完成跑 `npm test`，全部完成跑 `npm run verify`。
