# 04: 重复添加跳转

Status: Done

对应规格：R4（spec.md）

## 目标

重复添加时 toast 提供"查看"动作，一键定位到已有卡片并高亮，覆盖 Dialog 与 Picker 两条路径。

## 范围

- `extension/app.js`：
  - 新函数 `revealQuickLink(linkId, groupId)`：
    1. 确保处于标签看板视图（`setAppView`）
    2. 若 `activeQuickLinkGroupId` 过滤掉目标卡片（既不是"全部"也不是目标分组），切换 activeGroupId 并持久化、重渲染
    3. `document.querySelector('[data-link-id="..."]')?.scrollIntoView({ behavior: 'smooth', block: 'center' })` + 加 `.favorite-card-reveal` 高亮类，约 1.5s 后移除
  - 三处重复提示统一改为 `showToast(msg, { label: '查看', handler: () => revealQuickLink(...) })`：
    - `addPickerTabToGroup`（Picker 路径，~2445 行）
    - 表单提交 duplicate 分支（Dialog 路径，~4043 行）
    - `openQuickLinkPicker` 入口重复拦截（星标路径，~2408 行）
- `extension/styles/animation.css` 或 `favorites.css`：`.favorite-card-reveal` 高亮动画（背景闪烁/描边渐隐）

## 验收标准

1. Dialog 添加重复 URL → toast 出现"查看"按钮，点击滚动到既有卡片并高亮 ~1.5s
2. 星标点击已收藏标签 → 同样出现"查看"跳转
3. 目标卡片在非当前激活分组 → 跳转时自动切换分组后定位
4. 当前在时间线视图 → 跳转先切回标签看板
5. 卡片不存在（如已被删除）→ 静默无报错
6. 5s 内不点击，toast 自动消失，无残留 handler 泄漏

## 阻塞关系

- Blocks: 07（复用高亮动画样式）
- Blocked by: 无（Phase 2）

## Comments

- 2026-10-28: Dialog 提交路径按模式区分——创建模式关闭对话框后 toast + "查看"跳转；编辑模式因 `<dialog>` 顶层会遮挡 toast，改为 URL 字段行内错误提示"该网址已存在于「X」分组"并保留用户已填内容（对规格 R4 的小幅偏差，理由为平台约束）。星标与 Picker 路径按规格实现。
