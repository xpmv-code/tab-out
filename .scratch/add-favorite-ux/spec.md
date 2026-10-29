# Spec: 添加常用标签体验优化（add-favorite-ux）

Status: Approved（用户已在 grilling 中确认全部决策）

## 背景

添加常用标签目前有两个入口：

1. **Dialog 表单**（常用标签工具栏"添加"按钮 → `showQuickLinkForm`，6 字段：网址/名称/分组/描述/Badge/品牌色）
2. **Quick Link Picker**（标签看板星标按钮 → `openQuickLinkPicker`，浮动面板直接选分组）

现存痛点：表单字段过多摩擦大；URL 需手动完整输入；错误提示笼统（"请输入有效的网址"）；重复添加只有一行 toast 无法定位已有条目；AI 分类能力（categoryService）在添加时刻缺席，分组建议是事后补救；添加成功反馈单薄。

## 目标

降低添加摩擦、把错误与重复处理前置到输入时刻、把 AI 分组推荐前置到添加时刻并让推荐随使用习惯进化。

## 非目标

- 不改造 Quick Link Picker 为表单（Picker 保持"选分组"轻交互）
- 不做批量添加、不统一两处分组选择组件
- 不自动读取剪贴板、不自动用页面标题填充名称字段（用户已明确排除）
- 不改动云同步的数据结构（新增偏好数据仅存本地，不参与同步）

## 范围原则（已确认）

- **表单类**功能（渐进式表单、URL datalist、行内错误）只作用于 **Dialog**
- **反馈类**功能（重复跳转、智能推荐、丰富反馈）覆盖 **Dialog + Picker** 两个入口

---

## 需求明细

### R1 渐进式表单（Dialog）

- 创建模式默认只显示核心字段：**网址、网站名称、分组**
- **描述、Badge、品牌色**折叠进"更多选项"区域，点击展开/收起
- 编辑模式展开判定：`link.metadataSource === 'custom'` 时自动展开"更多选项"，否则保持折叠（自动推断的描述/颜色不算"有值"）
- 展开状态在 Dialog 打开期间有效；折叠区域内字段不参与布局占位
- 现有 `colorTouched` / `metadataSource` 提交逻辑保持不变：折叠状态下未填写的高级字段仍按 auto 处理

### R2 URL 智能输入（Dialog）

- URL 输入框绑定 `<datalist>`，候选来源：
  - 当前所有窗口的打开标签页（`chrome.tabs.query`，标题 + URL）
  - `chrome.history.search` 最近约 100 条记录
  - 两者按 URL 去重，标签页优先；过滤 `chrome://`、`chrome-extension://`、`about:` 等非网页协议
- 粘贴处理：`paste` 事件中对粘贴文本 trim 空白，并去除常见追踪参数（`utm_*`、`fbclid`、`gclid`、`ref`、`ref_src` 等），清理后写回输入框；若清理导致 URL 无参数则移除悬空 `?`。实际移除参数时，无协议文本会被规范化为 `https://` 完整 URL（与 normalizeQuickLinkUrl 一致）；未移除任何参数时保持原文仅 trim
- 纯本地处理，无网络请求；不读取剪贴板

### R3 行内错误提示（Dialog）

- URL 格式错误、非 http/https 协议 → URL 输入框下方行内错误文案（红色、`role="alert"`）
- 校验包含 hostname 合理性：无点裸单词（如 `notaurl`）视为格式错误，避免被静默补全为 `https://notaurl`；localhost、`.localhost`、IP 字面量不受影响
- 校验时机：**失焦（blur）+ 提交时**；用户重新输入即清除错误状态
- `addQuickLink` / `updateQuickLink` 的异常改为结构化错误 `{ field, message }`（内部保留 Error 兼容旧调用方），表单提交处按 `field` 定位到对应输入框行内显示
- 重复 URL 不占用行内错误：仍走 toast + R4 跳转
- 其余意外错误保留现有 toast 兜底

### R4 重复添加跳转（Dialog + Picker）

- 重复时 toast 文案保持"已存在于「X」分组"，新增 **"查看"** 动作按钮（复用 `showToast(message, {label, handler})`）
- 点击"查看"：
  1. 若当前不在标签看板视图，调用 `setAppView` 切换
  2. 若常用标签当前分组过滤不含目标卡片，切换 activeGroupId 到目标分组（或"全部"）并重渲染
  3. `scrollIntoView` 滚动到 `[data-link-id="<id>"]` 卡片并施加短暂高亮动画（约 1.5s）
- Dialog 提交路径与 Picker 路径、星标重复点击路径共用同一跳转函数

### R5 分组偏好存储（本地，新模块）

- 新模块 `extension/services/groupPreferenceService.js`（与 categoryService 同为 SW 可加载的 IIFE；app.js 页面侧直接用 `chrome.storage.local` 读写同一 key，或统一经 backgroundClient——实现时选择单一数据通路，避免双写）
- 数据结构：`{ [hostname]: { groupName, updatedAt } }`，key 如 `tabOutGroupPreferences`
- hostname 归一化：去 `www.` 前缀、小写；精确匹配，不做父域泛化
- 记录时机（全部记录最终选择）：
  1. Dialog 表单提交成功（add / update 且分组有值）
  2. Picker 选分组成功
  3. 编辑已有条目改变分组
  4. 接受事后分类建议（acceptFavoriteSuggestion）改变分组
- 上限 200 条，超出按 `updatedAt` 最旧淘汰（LRU）
- 提供 `record(hostname, groupName)`、`get(hostname)`、`getAll()`、`clear()`
- 工具栏新增"清除分组偏好"入口（`.favorites-toolbar` 内，图标按钮 + 确认 toast），调用 `clear()`
- 仅存 `chrome.storage.local`，不进云同步、不进 IndexedDB

### R6 智能分组推荐（Dialog + Picker）

- 推荐链路优先级：**用户偏好（R5） > 本地规则/AI 分类（categoryService → mapServiceCategory） > 不推荐**
- 复用现有 `TabOutBackgroundClient.getCategories`（规则 → 缓存 → DeepSeek，已含并发去重），不新建 AI 调用路径
- **Dialog**：URL 输入 debounce（约 500ms）后异步获取推荐分组名；若与当前选中分组不同，在分组 select 下方显示提示条："建议归入「X」 [采纳] [忽略]"（偏好来源时文案为"按你的习惯建议归入「X」"以区分信号来源）；采纳→切换 select 值（推荐分组不存在时创建）；忽略→**当前页面会话内**不再对该 hostname 提示（重开 Dialog 不重置）；推荐不阻塞提交；AI 分类为"其他"时不提示
- **Picker**：打开面板时异步获取推荐，命中后给对应分组按钮加"推荐"徽标/高亮样式；用户仍可任选
- 推荐仅当 hostname 可解析时触发；请求失败静默降级（无提示）
- 现有事后建议机制（queueFavoriteCategorySuggestions）保留不动，但记录/读取偏好后其命中率自然下降

### R7 丰富反馈（Dialog + Picker）

- 添加成功 toast 升级为：网站图标缩略图 + "已添加到「X」分组"（`showToast` 扩展可选 `iconUrl`，用 `getQuickLinkFaviconUrl(url)` 取图标；加载失败移除图标位并恢复默认对勾图标）
- 不自动切换视图；若用户当前已在标签看板且常用标签面板可见，新增卡片以高亮入场动画出现（复用 R4 的高亮样式，约 1.5s 渐隐）
- 编辑成功的 toast 保持文案，同样带图标
- 清除分组偏好时若无记录，toast 提示"暂无分组偏好记录"

---

## 修订记录

- 2026-10-28（实现后评审修订）：
  1. R2 补充：粘贴清理实际移除参数时会将无协议文本规范化为 `https://` URL（测试覆盖的有意行为）
  2. R3 补充：hostname 合理性校验（拒绝无点裸单词），为满足验收标准 3 的 `notaurl` 用例所必需
  3. R6 裁定："忽略"的会话语义为**页面会话级**（跨 Dialog 重开保持）；提示文案区分偏好来源（"按你的习惯…"）
  4. R7 补充：图标加载失败恢复默认对勾（优于单纯隐藏）；空偏好清除时 toast 提示
  5. R4 已批准偏差见 issues/04 Comments：编辑模式重复走行内错误（modal 顶层遮挡 toast 的平台约束）
  6. 已知规格空白（后续可选）：拖拽移动分组（moveQuickLink）暂不记录分组偏好，四时机枚举未含拖拽

---

## 验收标准

1. 创建模式打开 Dialog 只见 3 个核心字段 + "更多选项"折叠开关；编辑 auto 条目默认折叠，编辑 custom 条目自动展开
2. URL 输入框聚焦后可见打开标签/历史候选；粘贴带 `utm_source=x` 的 URL 后参数被清理且路径查询保留正确
3. 输入 `ftp://a.com` 或 `notaurl` 失焦 → 行内错误；改回合法 URL → 错误消失；提交非法 URL → 行内错误而非 toast
4. 添加已存在 URL（Dialog 或星标）→ toast 含"查看"，点击后滚动到既有卡片并高亮，跨分组/跨视图均有效
5. 添加 `github.com` 类站点 → Dialog 出现分组建议（若当前分组不同），采纳后 select 切换；Picker 中对应分组带推荐标记
6. 连续两次添加同域名不同路径站点到自选分组 → 第二次的推荐为用户上次选择的分组（偏好优先于 AI）
7. 偏好记录达到 200 条上限后最旧记录被淘汰；"清除分组偏好"清空全部记录
8. 添加成功 toast 显示图标 + 分组名；常用面板可见时新卡片有入场高亮
9. `npm run verify` 通过；新增纯逻辑函数（URL 清理、偏好 LRU、推荐优先级）有 `node --test` 单测覆盖
10. 未配置 DeepSeek key 时全部功能可用（推荐退化为规则+偏好）；无网络时添加流程不被阻塞

## 技术要点

- 运行时代码保持原生 JS IIFE 风格，与现有模块一致；新服务模块放 `extension/services/`
- `extension/index.html` 增加 datalist、行内错误容器、更多选项折叠区、推荐提示条、清除偏好按钮
- 样式加入 `extension/styles/favorites-dialog.css` / `favorites.css`，高亮动画可参考 `animation.css` 现有模式
- 纯逻辑（URL 清理、偏好存储、推荐合并）抽为可独立加载的模块或可测试函数，便于 `tests/` 用 node --test 直测（参考 `tests/cloud-sync.test.js` 的加载方式）
- 隐私不变式：所有新增数据均本地存储；AI 调用仍仅发送 hostname，且仅在用户已配置 DeepSeek key 时发生

## 领域语言

`CONTEXT.md` 新增术语：**分组偏好**——用户添加/移动常用标签页时留下的"域名→分组"选择记录，用于让智能推荐随使用习惯进化；仅存本地。

## 里程碑

- Phase 1：R1 + R2
- Phase 2：R3 + R4
- Phase 3：R5 → R6 → R7（R5 阻塞 R6）

每个 Phase 结束运行 `npm run verify` 后再进入下一个。
