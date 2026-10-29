# 06: 智能分组推荐（Dialog + Picker）

Status: Done

对应规格：R6（spec.md）

## 目标

添加时刻即给出分组推荐：偏好 > 规则/AI 分类 > 不推荐；Dialog 内可一键采纳，Picker 内高亮推荐分组。

## 范围

- `extension/app.js`：
  - 新函数 `resolveGroupRecommendation(url, groups)`：
    1. hostname 不可解析 → null
    2. `TabOutGroupPreferenceService.get(hostname)` 命中且分组名存在于 groups → `{ groupName, source: 'preference' }`
    3. 否则 `TabOutBackgroundClient.getCategories([hostname])` → `mapServiceCategory` → 非"其他"且存在于 groups（或可新建）→ `{ groupName, source: 'category' }`
    4. 失败静默返回 null
  - **Dialog**：`#quickLinkUrl` input debounce 500ms → 异步取推荐 → 与当前 select 分组名不同时在分组字段下方显示提示条"建议归入「X」 [采纳] [忽略]"；采纳→切 select 值；忽略→本次 Dialog 会话内该 hostname 不再提示；提交/关闭 Dialog 清理提示条与 debounce 定时器
  - **Picker**：`openQuickLinkPicker` 时异步取推荐，命中后给对应 `.quick-link-picker-group` 按钮加 `.recommended` 徽标（"推荐"角标）；用户仍可任选
  - 推荐异步不阻塞任何提交路径；未配置 DeepSeek 时链路退化为规则+偏好，功能不报错
- `extension/index.html`：Dialog 分组字段下方新增提示条容器（默认 hidden）
- `extension/styles/favorites-dialog.css` / `favorites.css`：提示条与 Picker 推荐徽标样式

## 验收标准

1. Dialog 输入已存在偏好的域名 → 500ms 后出现"建议归入「X」"（X=偏好分组）
2. 无偏好但规则命中的域名（如 github.com 且当前分组≠开发）→ 出现分类推荐
3. 点"采纳"→ select 切到推荐分组；点"忽略"→ 提示消失且同 hostname 本次不再出现
4. 推荐分组与当前选中相同时不显示提示
5. Picker 打开时推荐分组按钮带"推荐"徽标；推荐晚到时徽标异步补上
6. AI 分类返回"其他"或请求失败 → 无任何提示，无 console 错误
7. 推荐优先级逻辑（偏好>分类>null）有单测，`npm test` 通过

## 阻塞关系

- Blocks: 无
- Blocked by: 05

## Comments
