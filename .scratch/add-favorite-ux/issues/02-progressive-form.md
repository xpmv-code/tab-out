# 02: 渐进式表单（折叠高级字段）

Status: Done

对应规格：R1（spec.md）

## 目标

创建模式默认只展示核心 3 字段，降低添加摩擦；编辑模式按 metadataSource 智能展开。

## 范围

- `extension/index.html`：`#quickLinkForm` 中将描述/Badge/品牌色三个 `.favorite-field` 包进 `<div class="favorite-advanced" hidden>`，前面加"更多选项"切换按钮（含展开状态 aria-expanded）
- `extension/app.js`：
  - `showQuickLinkForm`：创建模式 → 折叠；编辑模式 → `link.metadataSource === 'custom'` 时展开，否则折叠
  - 切换按钮 action（如 `toggle-favorite-advanced`）控制展开/收起
  - 折叠状态下提交逻辑不变（未填写字段仍按现有 auto/custom 判定）
- `extension/styles/favorites-dialog.css`：折叠区样式、切换按钮样式、展开过渡

## 验收标准

1. 创建模式打开 Dialog：只见网址/名称/分组 + "更多选项"按钮
2. 点"更多选项"：展开描述/Badge/品牌色；再点收起
3. 编辑 `metadataSource === 'custom'` 的条目：自动展开
4. 编辑 auto 条目：默认折叠，可手动展开
5. 折叠状态下填写了描述再展开提交，`metadataSource` 判定与现状一致（填了高级字段 → custom）
6. 键盘可达：Tab 能到达切换按钮，Enter/Space 可切换

## 阻塞关系

- Blocks: 无
- Blocked by: 无（与 01 同属 Phase 1，可并行）

## Comments
