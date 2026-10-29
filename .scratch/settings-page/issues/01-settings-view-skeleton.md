# 01: 设置视图骨架（第三入口 + setAppView 三态）

Status: Done

对应规格：R1（spec.md）

## 目标

视图切换器出现第三个并列入口"设置"，点击可打开带四个分区的设置页骨架。

## 范围

- `extension/index.html`：
  - `.view-switcher` 内新增按钮：齿轮图标 + "设置"，`data-action="switch-view" data-view="settings"`，`role="tab"`，`aria-selected="false"`，`aria-controls="settingsView"`
  - timelineView `</main>` 之后新增 `<main class="app-view settings-view dashboard-panel" id="settingsView" role="tabpanel" hidden>`，含四个 `<section>`：外观（settingsAppearance）、常用标签页数据（settingsData）、云同步（settingsSync）、网站分类（settingsCategories）——本票只建骨架标题与容器，内容由 02/03 填充
- `extension/app.js`：
  - `setAppView`：三态解析 `timeline | settings | dashboard`；三个视图互斥 hidden；`renderSettingsView()` 在 settings 分支调用
  - 新函数 `renderSettingsView()`：null-safe 刷新设置页动态状态（本票先做空实现/占位，02/03 扩展）
- `extension/styles/`：settingsView 分区样式（复用 dashboard-panel 视觉语言；分区标题+行布局），加在 unified-panels.css 或新 settings.css（若新建需加入 style.css @import 链）

## 验收标准

1. 头部三入口并列：标签看板 | 时间线 | 设置，aria-selected 随切换更新
2. 切到设置：看板/时间线隐藏，分组方式控件隐藏；四分区骨架可见
3. 从设置切回看板/时间线功能正常（时间线仍会加载数据）
4. `revealQuickLink` 在设置视图下触发时先切回看板（activeAppView 判断已覆盖，回归确认）
5. 现有 45 项测试通过（app.js VM 加载安全：renderSettingsView 不在加载期调用）

## 阻塞关系

- Blocks: 02, 03
- Blocked by: 无

## Comments
