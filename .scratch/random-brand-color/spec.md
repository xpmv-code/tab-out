# Spec: 未选品牌色时随机生成（random-brand-color）

Status: Approved（小功能，用户单句需求 + 一项实现裁定）

## 需求

添加一个网站时，若用户没有选择品牌色，随机生成一个品牌色，替代现有"分组类别色"回退。

## 实现裁定（可翻转）

**已知站点品牌色保留**（`inferKnownSite` 的 ~25 条手工品牌色，如 GitHub `#65758b`、bilibili `#d95f91`）——那是"识别出的颜色"而非"没颜色"；随机色只替换类别色回退。若希望完全随机（连已知站点也随机），只需改 `enrichFavorite` 一行。

## 行为定义

- **生效范围**：`enrichFavorite` 的颜色回退链变为 `用户自选色 > 已知站点品牌色 > 随机色`（原为 `自选 > 已知 > 类别色`）
- **随机色生成**：HSL 随机色调（0-360°），饱和度 55-67%、亮度 42-54%——与现有柔和色板气质一致，避免刺眼/浑浊的纯随机 RGB
- **赋值一次即持久**：随机色在 enrich 时写入 link.color 并存储，后续保存/渲染不再变化
- **覆盖路径**：Dialog 添加（未触碰颜色控件）、Picker 星标添加、导入 JSON 中无颜色的链接、编辑保存中传空颜色的边缘情形
- **不变**：Dialog 编辑路径始终回传预填颜色（现状）；`inferFavoriteMetadata` 对未知站点返回 `color: ''`（app.js 表单预填的 truthy 守卫已兼容）

## 验收标准

1. Dialog 添加未知网站不碰颜色 → 卡片获得合法随机 `#rrggbb` 色，且与分组类别色不同
2. 同一未知网站两次添加 → 两次颜色不同（随机性）
3. 已知站点（如 github.com）无颜色 → 保留其品牌色
4. 用户自选色（colorTouched）→ 完全保留，不受影响
5. 随机色格式通过 `sanitizeColor` 校验（合法 6 位小写 hex）
6. 单测覆盖上述行为，`npm run verify` 通过

## 里程碑

单 ticket：01-random-brand-color（favorites-metadata.js 单模块改动 + 新测试文件）。
