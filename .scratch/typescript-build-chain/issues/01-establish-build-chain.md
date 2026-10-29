# 01 — 建立零行为变化的 TypeScript 构建链

**What to build:** 加入 TypeScript、esbuild 和统一验证命令，把现有扩展转换为目录结构一致的 `dist/extension/` 构建镜像，并用同一套测试验证源码与构建产物。

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] 加入 `package.json`、锁文件和严格但允许 JavaScript 渐进迁移的 `tsconfig.json`。
- [x] 加入可重复清理并生成 `dist/extension/` 的构建脚本。
- [x] 保持 `extension/`、HTML、manifest 和脚本加载顺序不变。
- [x] 让现有测试可以复用到源码与构建产物。
- [x] 加入类型检查、语法检查和统一验证命令。
- [x] 完整验证通过后记录结果。

## Comments

- 2026-07-20：用户确认按既定迁移顺序先建立构建链，不迁移 TypeScript 文件，不改变功能。
- 2026-07-20：`npm run verify` 通过；12 个现有脚本完成构建，源码与构建产物各 5 项测试通过，manifest/HTML 保持一致，全部生成脚本通过语法检查。
- 2026-07-20：隔离的 headless Chrome 不支持对临时 profile 应用新标签页覆盖，因此 `dist/extension/` 的真实新标签页视觉检查仍需在 `chrome://extensions` 手动完成。
