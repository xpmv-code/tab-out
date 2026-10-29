# 03: 行内错误提示

Status: Done

对应规格：R3（spec.md）

## 目标

URL 格式/协议错误在输入框下方行内显示，替代笼统 toast；错误随输入即时清除。

## 范围

- `extension/app.js`：
  - `addQuickLink` / `updateQuickLink` 抛出的错误附带结构化信息：`err.field = 'url'`、`err.code = 'missing-url' | 'invalid-url' | 'unsupported-protocol'`（保持 Error 类型以兼容现有 catch）
  - 新函数 `showFieldError(fieldId, message)` / `clearFieldError(fieldId)`：在字段容器内插入/移除 `<p class="favorite-field-error" role="alert">`
  - `#quickLinkUrl` blur 校验：非空时用与 `normalizeQuickLinkUrl`/`isSupportedQuickLinkUrl` 一致的规则校验并行内提示；input 事件清除错误
  - 表单提交 catch：`err.field === 'url'` → 行内提示 + focus；其余 → 现有 toast 兜底
  - 重复 URL（`status === 'duplicate'`）保持 toast 路径（04 会增强）
- `extension/index.html`：无需新增静态节点（错误节点动态插入）
- `extension/styles/favorites-dialog.css`：`.favorite-field-error` 样式（红色、小字号）

## 验收标准

1. 输入 `notaurl` 失焦 → 行内错误"请输入有效的网址"；焦点回到输入框重新输入 → 错误消失
2. 输入 `ftp://a.com` 提交 → 行内错误"仅支持 http/https 链接"，无 toast
3. 空 URL 提交 → 浏览器原生 required 拦截或行内错误（二者取其一，行为一致即可）
4. 合法 URL 正常提交，无错误残留
5. 编辑模式同样生效
6. 错误映射函数有单测，`npm test` 通过

## 阻塞关系

- Blocks: 无
- Blocked by: 无（Phase 2）

## Comments
