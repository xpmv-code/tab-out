# 01 — 将时间线搜索迁移到 TypeScript

**What to build:** 以 `src/timeline/timeline-search.ts` 作为唯一手写源码，由构建链生成兼容的 `extension/timeline-search.js`，保持单一公开接口及全部既有搜索行为不变。

**Blocked by:** `.scratch/typescript-build-chain/issues/01-establish-build-chain.md` — completed.

**Status:** completed

- [x] 测试通过真实浏览器全局接口验证 `searchTimeline`。
- [x] 增加明确的时间线快照、记录、会话、匹配和分页类型。
- [x] 保持 `searchTimeline(snapshot, query, options)` 的行为与返回结构不变。
- [x] 构建链从 TypeScript 生成 `extension/timeline-search.js`。
- [x] `extension/index.html` 的脚本路径和顺序保持不变。
- [x] 源码与构建镜像完整验证通过。
- [x] 双轴代码审查通过。

## Comments

- 2026-07-20：用户指定按既定迁移顺序开始迁移时间线搜索。
- 2026-07-20：先删除原 JavaScript 交付文件确认测试因缺少浏览器脚本进入红阶段，再增加 TypeScript 源码和生成步骤恢复为绿。
- 2026-07-20：`npm run verify` 通过类型检查、1 个 TypeScript 模块生成、12 个 JavaScript 文件构建、静态/语法检查，以及源码和构建镜像各 6 项测试。
- 2026-07-20：双轴审查的规格轴无发现；标准轴提出的命中状态非法组合已用判别联合修正，复核后无剩余发现。
- 2026-07-20：真实 Chrome 新标签页的视觉与交互检查仍需在 `chrome://extensions` 重新加载扩展后手动完成。
