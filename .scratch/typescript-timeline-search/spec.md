# 时间线搜索 TypeScript 迁移规格

## Problem Statement

时间线搜索已经拥有稳定的纯模块接口和行为测试，但唯一源码仍是直接交付给 Chrome 的 `extension/timeline-search.js`。后续 TypeScript 迁移若继续直接编辑交付产物，会形成源码与生成文件混用，无法通过类型系统约束时间线快照、树节点、会话、匹配线索和分页结果。

## Solution

把时间线搜索的唯一手写源码迁移到 `src/timeline/timeline-search.ts`。构建链先从该 TypeScript 文件生成兼容的 `extension/timeline-search.js`，再按现有流程生成 `dist/extension/` 镜像。Chrome 与调用方继续使用 `globalThis.TabOutTimelineSearch.searchTimeline(snapshot, query, options)`，搜索语义和返回结构保持不变。

## Implementation Decisions

- `src/timeline/timeline-search.ts` 是时间线搜索唯一手写实现，类型与实现共置于同一深模块。
- 公开接口仍只有 `searchTimeline(snapshot, query, options)`；规范化、匹配、上下文保留和分页函数保持内部私有。
- TypeScript 源码导出接口类型与 `searchTimeline`，便于后续 `app.js` 迁移时直接复用。
- 浏览器交付产物仍位于 `extension/timeline-search.js`，并继续暴露 `globalThis.TabOutTimelineSearch`，因此不修改 HTML 脚本路径或加载顺序。
- `extension/timeline-search.js` 是构建生成物，保留在仓库中以维持普通用户无需 Node.js 的安装契约。
- esbuild 使用单独的 TypeScript 入口生成浏览器 IIFE，然后现有旁路构建继续处理全部扩展 JavaScript。
- 测试改为通过真实浏览器全局接口加载模块，不再依赖仅供 Node 使用的 CommonJS 分支。

## Testing Decisions

- 继续复用已确认的唯一测试 seam：`searchTimeline(snapshot, query, options)`。
- 现有 AND 匹配、树上下文、真实匹配分页、网址线索和零结果测试的期望值不变。
- 增加浏览器脚本确实暴露稳定全局接口的测试。
- 同一套测试继续分别运行在 `extension/` 与 `dist/extension/`。
- `tsc --noEmit` 必须检查 TypeScript 源码，所有生成 JavaScript 继续执行语法检查。

## Out of Scope

- 改变搜索字段、AND 语义、分页规则、会话或标签树上下文。
- 修改搜索 UI、DOM 接入、样式或快捷键。
- 迁移 `app.js`、`timeline-data.js` 或后台脚本。
- 改变 HTML、manifest、Chrome 权限或普通用户安装路径。
- 引入新的运行时依赖。
