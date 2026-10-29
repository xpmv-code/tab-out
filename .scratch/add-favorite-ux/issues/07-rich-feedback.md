# 07: 丰富反馈（富 Toast + 入场高亮）

Status: Done

对应规格：R7（spec.md）

## 目标

添加/编辑成功的反馈带网站图标与分组名；常用面板可见时新卡片有入场高亮动画。

## 范围

- `extension/app.js`：
  - `showToast(message, action)` 扩展第三参或 action 对象增加可选 `iconUrl`：toast 内插入 `<img class="toast-icon">`，加载失败（onerror）移除图标位；无 iconUrl 时 DOM 与现状一致
  - 添加成功处（Dialog 提交、`addPickerTabToGroup`）toast 改为：icon=`getQuickLinkFaviconUrl(url)`，文案=`已添加到「分组名」`
  - 编辑成功 toast 同样带图标
  - 新函数 `highlightQuickLinkCard(linkId)`：若卡片在当前 DOM 中（面板可见且未被分组过滤）→ 加 `.favorite-card-reveal`（复用 04 的样式）约 1.5s；不在 DOM 则静默跳过（不切换视图、不自动跳转）
- `extension/index.html`：toast 结构无需静态改动（图标动态插入）
- `extension/styles/`：`.toast-icon` 样式；`.favorite-card-reveal` 复用 04

## 验收标准

1. Dialog/Picker 添加成功 → toast 左侧显示网站图标 + "已添加到「X」分组"
2. 图标加载失败 → toast 无破图，文案正常
3. 用户停留在常用标签面板（目标分组可见）→ 新卡片入场高亮 ~1.5s 渐隐
4. 用户在时间线视图或卡片被分组过滤 → 不自动切换视图、无报错，仅 toast
5. 编辑成功 toast 带图标
6. 现有不带 action 的 showToast 调用行为不变（回归）

## 阻塞关系

- Blocks: 无
- Blocked by: 04（复用高亮样式与动画时长约定）

## Comments
