# 02: 主题三态切换（theme.js + CSS data-theme 改造）

Status: Done

对应规格：R2（spec.md）

## 目标

设置页外观区可切换 跟随系统/浅色/深色，立即生效、持久化、零首帧闪烁。

## 范围

- 新文件 `extension/theme.js`（head 同步加载，MV3 CSP 合规）：
  - `resolveMode(mode, prefersDark)`：纯函数，`system` → prefersDark ? 'dark' : 'light'；其余原样
  - `getMode()`：读 `localStorage['tabOutThemeMode']`，非法值回落 'system'
  - `setMode(mode)`：校验三值、写 localStorage、apply
  - `apply()`：`document.documentElement.dataset.theme = resolveMode(getMode(), matchMedia(...).matches)`
  - 挂载 `globalThis.TabOutTheme = { getMode, setMode, resolveMode, apply }`；文件尾立即 `apply()`
- `extension/index.html`：`<head>` 内 style.css 之后加 `<script src="theme.js"></script>`；设置页外观区三分段按钮（复用 group-by-switcher 视觉模式）：`data-action="set-theme"` + `data-theme-mode="system|light|dark"` + aria-pressed
- `extension/styles/base.css`：`@media (prefers-color-scheme: dark) { :root {...} }` → `:root[data-theme="dark"] {...}`（变量内容不动，color-scheme 随迁）
- `extension/styles/favorites.css`：同样转换（6 变量块）
- `extension/app.js`：
  - `set-theme` action → `TabOutTheme.setMode(mode)` + 更新三段按钮 aria-pressed/active
  - INIT 注册 `matchMedia('(prefers-color-scheme: dark)')` change 监听：mode==='system' 时重新 apply + 若设置页打开刷新按钮态
  - `renderSettingsView()` 同步主题按钮状态
- `tests/settings-theme.test.js`：VM 加载 theme.js（stub localStorage/matchMedia/document），测 resolveMode 三态、getMode 非法回落、setMode 持久化+apply

## 验收标准

1. 三段控件切换立即换肤；刷新/重开浏览器保持选择
2. system 模式随系统偏好变化实时切换（matchMedia 监听）
3. 首帧无闪烁（theme.js 同步早于 body 渲染）
4. 深色样式与改造前一致（变量块内容未变，仅选择器包裹变化）
5. theme.js 单测通过；全量测试通过

## 阻塞关系

- Blocks: 无
- Blocked by: 01

## Comments
