# Tab Out

**把散落在多个 Chrome 窗口里的标签页，变成一个一眼就能看懂的本地看板。**

Tab Out 是一个 Chrome Manifest V3 扩展，会替换浏览器的新标签页。它可以按域名或网站类型整理所有已打开的标签页，并提供搜索、去重、稍后查看、常用标签页、工作空间、浏览时间线和本地清理统计。

核心功能默认本地优先，无需账号、服务器、Node.js 或构建步骤。可选的云同步功能需要用户自备 Supabase 项目和独立的 Tab Out 邮箱账号；未配置时不会连接 Supabase，现有本地功能不变。常用标签页网站图标会将对应域名发送到 Favicon.im；只有主动配置 DeepSeek 后，未知网站的主机名才会发送到 DeepSeek API 进行分类。仓库开发者可使用可选的 TypeScript 与 esbuild 工具链验证后续迁移。

## 当前功能

### 标签页看板

- 汇总所有 Chrome 窗口中的网页标签页，并随标签页的创建、关闭、更新和激活实时刷新
- 支持按**域名**或**网站类型**分组；内置 AI 工具、视频、开发、搜索、社交、购物、新闻、文档、效率工具等分类
- 将 Gmail、X、LinkedIn、YouTube、GitHub 等站点的首页集中到独立的“首页”分组
- 按标题、域名或网址搜索，并可一次关闭全部搜索结果
- 点击标题即可跳转到对应标签页，即使它位于另一个 Chrome 窗口
- 支持关闭单个标签页、整个分组、全部标签页或多余的 Tab Out 页面
- 按完整网址识别重复标签页，显示重复数量，并一键保留一份、关闭其余副本
- 每组默认显示前 8 个不同页面，其余内容可展开查看
- `localhost` 标签页会显示端口号，本地文件会单独归组
- 关闭标签页时播放 Web Audio 合成的滑动音效并显示纸屑动画
- 扩展图标角标显示当前网页标签数量，并按数量变化颜色

### 常用标签页

- 手动添加网站，或直接把当前打开的标签页加入常用列表
- 自定义名称、描述、Badge、品牌色和分组
- 新建、重命名、删除分组；拖拽调整分组和链接顺序，也可跨分组移动
- 自动提示更合适的网站分类，可接受或忽略建议
- 删除后支持撤销，重复网址不会被再次添加
- 使用 JSON 导入或导出全部常用标签页与分组

### 跨 Chrome 配置文件云同步（可选）

使用此功能可让不同 Google 账号登录的 Chrome 配置文件共享同一份常用标签页。每个配置文件都需要安装 Tab Out，并登录同一个独立的 Tab Out 邮箱账号。

1. 在 Supabase 创建项目，建议选择距离自己较近的数据区域。
2. 在 Supabase SQL Editor 中执行仓库文件 supabase/migrations/20261017000000_quick_link_sync.sql。
3. 在 Supabase Authentication 的邮件模板中，配置 Email OTP 模式，并在邮件正文使用 {{ .Token }} 发送数字验证码（不要只发送 magic link）。
   注意：Supabase 默认邮件服务通常只向 Supabase 组织成员邮箱发送邮件，并且发送频率受限。要让任意邮箱都能注册登录，需在 Authentication → SMTP Settings 配置自定义 SMTP；详见 [Supabase 官方说明](https://supabase.com/docs/guides/auth/auth-smtp)。

4. 在被 Git 忽略的 extension/config.local.js 中添加以下配置，替换为 Supabase 项目 URL 和客户端 Publishable key（旧项目可使用 anon key）：

   ~~~javascript
   globalThis.TAB_OUT_SYNC_CONFIG = {
     supabaseUrl: 'https://YOUR_PROJECT_REF.supabase.co',
     publishableKey: 'YOUR_PUBLISHABLE_KEY',
   };
   ~~~

   不要填写 service_role、secret key 或数据库密码。客户端 key 本身不是机密；真正的数据隔离由数据库 RLS 完成。
5. 在 chrome://extensions 重新加载扩展，打开新标签页，点击常用标签区域的“云同步”，请求 Supabase 主机权限并通过邮箱验证码登录。
6. 在其他 Chrome 配置文件中重复安装/加载扩展、添加同样的本地 Supabase 配置，然后登录同一个 Tab Out 账号。

首次同步会保留并合并本地收藏，不会直接用云端覆盖本地。修改通常会在新标签页内很快推送；Chrome 运行期间，Service Worker 也会使用 Alarms 定期拉取云端变化（约每 5 分钟一次），并对失败的待同步操作安排持久重试，因此不必一直开着新标签页。离线时保持本地可用，恢复网络后重试；浏览器完全退出期间不会执行网络同步。第一阶段只同步常用标签页、分组与顺序；工作空间、浏览历史、时间线、统计和缓存仍保留在各自本地。

隐私说明：启用后，常用标签页的标题、网址、分组和自定义字段会发送到你配置的 Supabase 项目并在登录设备间共享。Supabase Auth 保存登录账号信息；访问令牌保存在当前 Chrome 配置文件的本地扩展存储中。Favicon.im 的图标请求仍会独立发送网站域名。不同的 Tab Out 账号拥有相互隔离的云端记录。

### 稍后查看

- 将某个已打开标签页保存到“稍后查看”，随后关闭原标签页
- 以待办清单管理保存内容，完成后自动进入归档
- 支持搜索归档内容或从列表移除条目
- 保存内容跨浏览器会话保留

### 工作空间

- 将当前窗口中可恢复的标签页保存为一个工作空间快照
- 重命名、更新或删除已有工作空间
- 在新窗口恢复，或合并到当前窗口
- 使用 JSON 导入或导出工作空间

### 浏览时间线与清理统计

- 读取最近 48 小时、最多 1000 条本地浏览历史，并按 30 分钟间隔聚合为浏览会话
- 根据 `openerTabId` 展示当前标签页之间的父子关系，点击节点可跳转或重新打开页面
- 记录当天通过 Tab Out 关闭的标签页数量
- 按每个标签页 50 MB 估算释放的内存；该数值是估算值，不是系统实测值
- 显示当前重复标签页数量和重复率
- 网页标签页超过 50 个时显示清理提醒
- 时间线会话、清理统计和分类缓存均保存在本地 IndexedDB

## 安装

### 使用编码助手安装

把下面的仓库地址发送给 Codex、Claude Code 等编码助手，并告诉它“安装这个 Chrome 扩展”：

```text
https://github.com/xpmv-code/tab-out
```

### 手动安装

1. 克隆仓库：

   ```bash
   git clone https://github.com/xpmv-code/tab-out.git
   cd tab-out
   ```

2. 创建本地配置文件。即使不使用 DeepSeek，当前版本的后台脚本也需要这个文件存在：

   macOS / Linux：

   ```bash
   touch extension/config.local.js
   ```

   Windows PowerShell：

   ```powershell
   New-Item extension/config.local.js -ItemType File -Force
   ```

3. 在 Chrome 地址栏打开 `chrome://extensions`。
4. 打开右上角的**开发者模式**。
5. 点击**加载已解压的扩展程序**，选择仓库中的 `extension/` 文件夹。
6. 打开一个新标签页，即可进入 Tab Out。

无需运行服务器，也无需执行 `npm install`。

## 快速使用

1. 在顶部切换“标签看板”和“时间线”。
2. 在标签看板中选择按“域名”或“类型”分组。
3. 点击标签标题跳转；使用星标按钮加入常用标签页，书签按钮保存到稍后查看，`×` 关闭单个标签页。
4. 在分组卡片底部关闭整组标签页，或清理该组中的重复项。
5. 使用“保存当前窗口”创建工作空间，需要时在新窗口恢复或合并到当前窗口。

## 可选：启用 DeepSeek 分类

内置规则无法识别的网站默认归入“其他”。如需让 DeepSeek 为未知网站分类，在 `extension/config.local.js` 中添加：

```js
globalThis.DEEPSEEK_API_KEY = 'your-api-key';
globalThis.DEEPSEEK_MODEL = 'deepseek-chat';
```

保存后，在 `chrome://extensions` 中重新加载扩展。

注意：

- `extension/config.local.js` 已被 `.gitignore` 排除，不应提交真实 API 密钥
- 启用后，仅未知网站的主机名会发送到 `https://api.deepseek.com`
- 分类结果会缓存在本地 IndexedDB，减少重复请求
- 不配置 API 密钥时不会发起分类网络请求

## 数据与隐私

| 数据 | 存储位置 | 是否联网 |
| --- | --- | --- |
| 稍后查看、常用标签页、工作空间、当前常用分组 | `chrome.storage.local` | 否 |
| 分组偏好（域名→分组选择记录） | `chrome.storage.local` | 否 |
| 主题偏好（浅色/深色/跟随系统） | 页面 `localStorage` | 否 |
| 浏览时间线会话、清理统计、网站分类缓存 | 本地 IndexedDB | 否 |
| 当前打开的标签页 | 通过 Chrome Tabs API 实时读取 | 否 |
| 常用标签页网站图标 | Favicon.im API（仅发送域名） | 是 |
| 未知网站分类 | DeepSeek API，仅在配置密钥后启用 | 是，仅发送主机名 |

扩展申请以下 Chrome 权限：

- `tabs` / `activeTab`：读取、跳转、创建和关闭标签页
- `storage`：保存常用标签页、稍后查看和工作空间
- `history`：生成最近浏览时间线
- `favicon`：显示 Chrome 提供的网站图标后备来源
- 常用标签页主图标通过 `https://a.favicon.im/{domain}` 获取；请求失败时回退到 Chrome 图标接口和网站的 `/favicon.ico`
- `https://api.deepseek.com/*`：支持可选的网站类型分类

## 更新

在仓库目录中拉取最新代码：

```bash
git pull
```

然后打开 `chrome://extensions`，点击 Tab Out 卡片上的**重新加载**按钮。

## 开发与构建

普通用户仍然直接加载 `extension/`，无需执行本节命令。开发者首次准备环境时运行：

```bash
npm ci
```

完整验证命令会依次执行 TypeScript 配置检查、esbuild 构建、生成脚本语法检查，并把现有测试分别运行在源码和构建产物上：

```bash
npm run verify
```

只更新 TypeScript 生成文件并生成构建镜像时运行：

```bash
npm run build
```

时间线搜索的手写源码位于 `src/timeline/timeline-search.ts`，命令会先更新供 Chrome 直接加载的 `extension/timeline-search.js`。完整构建镜像位于 `dist/extension/`；该目录可能包含从本地复制的 `config.local.js`，因此已被 Git 忽略，不应提交。

## 项目结构

```text
src/
└── timeline/
    └── timeline-search.ts       # 时间线搜索 TypeScript 源码

extension/
├── manifest.json              # Chrome 扩展清单
├── index.html                 # 新标签页界面
├── app.js                     # 看板、常用标签页、稍后查看与工作空间
├── background.js              # Service Worker、角标与后台消息
├── timeline-data.js           # 浏览历史清洗、会话聚合与标签树
├── timeline-search.js         # 从 TypeScript 生成的浏览器脚本
├── constants/                 # 网站分类规则
├── favorites/                 # 常用标签页元数据与渲染
├── services/                  # 分类和清理统计服务
├── storage/                   # IndexedDB 与分类缓存
└── styles/                    # 页面样式和动画
```

## 技术栈

- Chrome Manifest V3
- 原生 HTML、CSS、JavaScript
- TypeScript + esbuild（仅开发构建链，运行时仍为 JavaScript）
- Chrome Tabs、Windows、History、Storage 和 Favicon API
- `chrome.storage.local` + IndexedDB
- Web Audio API + CSS 动画
- 可选 DeepSeek Chat Completions API

## 许可证与致谢

本项目采用 [MIT License](LICENSE)。

Tab Out 原项目由 [Zara](https://x.com/zarazhangrui) 创建。
