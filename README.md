# Tab Out

**把散落在多个 Chrome 窗口里的标签页，变成一个一眼就能看懂的本地看板。**

Tab Out 是一个 Chrome Manifest V3 扩展，会替换浏览器的新标签页。它可以按域名或网站类型整理所有已打开的标签页，并提供搜索、去重、稍后查看、常用标签页、工作空间、浏览时间线和本地清理统计。

项目不需要服务器、账号、Node.js 或构建步骤。默认情况下，数据只保存在浏览器本地；只有主动配置 DeepSeek 后，未知网站的主机名才会发送到 DeepSeek API 进行分类。

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
| 浏览时间线会话、清理统计、网站分类缓存 | 本地 IndexedDB | 否 |
| 当前打开的标签页 | 通过 Chrome Tabs API 实时读取 | 否 |
| 未知网站分类 | DeepSeek API，仅在配置密钥后启用 | 是，仅发送主机名 |

扩展申请以下 Chrome 权限：

- `tabs` / `activeTab`：读取、跳转、创建和关闭标签页
- `storage`：保存常用标签页、稍后查看和工作空间
- `history`：生成最近浏览时间线
- `favicon`：显示网站图标
- `https://api.deepseek.com/*`：支持可选的网站类型分类

## 更新

在仓库目录中拉取最新代码：

```bash
git pull
```

然后打开 `chrome://extensions`，点击 Tab Out 卡片上的**重新加载**按钮。

## 项目结构

```text
extension/
├── manifest.json              # Chrome 扩展清单
├── index.html                 # 新标签页界面
├── app.js                     # 看板、常用标签页、稍后查看与工作空间
├── background.js              # Service Worker、角标与后台消息
├── timeline-data.js           # 浏览历史清洗、会话聚合与标签树
├── constants/                 # 网站分类规则
├── favorites/                 # 常用标签页元数据与渲染
├── services/                  # 分类和清理统计服务
├── storage/                   # IndexedDB 与分类缓存
└── styles/                    # 页面样式和动画
```

## 技术栈

- Chrome Manifest V3
- 原生 HTML、CSS、JavaScript
- Chrome Tabs、Windows、History、Storage 和 Favicon API
- `chrome.storage.local` + IndexedDB
- Web Audio API + CSS 动画
- 可选 DeepSeek Chat Completions API

## 许可证与致谢

本项目采用 [MIT License](LICENSE)。

Tab Out 原项目由 [Zara](https://x.com/zarazhangrui) 创建。
