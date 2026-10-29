# 01: 未选品牌色时随机生成

Status: Ready

对应规格：random-brand-color/spec.md

## 范围

- `extension/favorites/favorites-metadata.js`：
  - 新增私有 `hslToHex(h, s, l)` 与导出 `generateBrandColor()`（HSL 随机色调，s 0.55-0.67、l 0.42-0.54）
  - `inferFavoriteMetadata`：`color: known?.color || ''`（未知站点不再返回类别色）
  - `enrichFavorite`：`color: sanitizeColor(link.color, inferred.color || generateBrandColor())`
  - 导出面追加 `generateBrandColor`
- `tests/brand-color.test.js`（新）：VM 直载 favorites-metadata.js，覆盖格式/随机性/已知站点保留/自选色保留/无效色回退

## 验收标准

见 spec.md（6 条）。

## 阻塞关系

- Blocks: 无 / Blocked by: 无

## Comments
