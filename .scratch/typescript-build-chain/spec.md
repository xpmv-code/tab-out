# TypeScript 构建链第一阶段规格

## Problem Statement

Tab Out 当前直接从 `extension/` 加载多个原生 JavaScript 文件，没有 TypeScript 类型检查或构建步骤。后续若直接逐文件改为 TypeScript，会同时改变源码格式、脚本加载方式和扩展安装路径，难以区分构建问题与功能回归。

## Solution

先建立一条旁路构建链：使用 esbuild 把现有 JavaScript 转换到 `dist/extension/`，同时原样复制 manifest、HTML、CSS、图标和本地配置，生成与 `extension/` 目录结构一致的可加载扩展镜像。现有 `extension/` 继续作为运行真源，本阶段不修改任何脚本引用或扩展行为。

## Implementation Decisions

- 使用 TypeScript 提供 `tsc --noEmit` 类型检查，并通过 `allowJs` 接受尚未迁移的 JavaScript。
- 使用 esbuild 转换 `extension/` 下除 `config.local.js` 外的全部 JavaScript，并保持相对路径不变。
- 构建前清理固定目标 `dist/extension/`，再复制静态资源并覆盖生成后的 JavaScript。
- `config.local.js` 只作为本地文件复制，不交给 esbuild，也不进入 Git；`dist/` 整体加入 `.gitignore`。
- 不修改 `extension/index.html`、`extension/manifest.json` 或当前 Chrome 加载目录。
- 保留现有 `node:test`，让同一套行为测试可以分别读取源码目录和构建目录。
- 提供单一 `npm run verify` 命令，依次执行类型检查、构建、源码测试和构建产物测试。

## Testing Decisions

- 现有测试默认继续针对 `extension/`。
- 通过环境变量把同一套测试重定向到 `dist/extension/`，验证构建产物的公开行为。
- 对全部生成 JavaScript 执行 Node 语法检查。
- 验证源码与构建目录的 manifest 和 HTML 保持一致。

## Out of Scope

- 把任何现有 `.js` 文件改为 `.ts`。
- 拆分 `app.js` 或改变模块接口。
- 修改页面脚本顺序、后台 Service Worker 模式或 manifest。
- 引入 UI 框架、新功能或新的 Chrome 权限。
- 改变用户当前从 `extension/` 加载扩展的安装流程。
