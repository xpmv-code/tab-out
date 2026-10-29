import { access, cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const extensionRoot = path.join(repositoryRoot, 'extension');
const outputRoot = path.join(repositoryRoot, 'dist', 'extension');
const localConfigPath = path.join(extensionRoot, 'config.local.js');
const timelineSearchSourcePath = path.join(repositoryRoot, 'src', 'timeline', 'timeline-search.ts');
const timelineSearchOutputPath = path.join(extensionRoot, 'timeline-search.js');

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectJavaScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith('.js') && entryPath !== localConfigPath) {
      files.push(entryPath);
    }
  }

  return files;
}

await access(localConfigPath).catch(() => {
  throw new Error('缺少 extension/config.local.js；请先创建空文件或本地配置后再构建。');
});

await build({
  entryPoints: [timelineSearchSourcePath],
  outfile: timelineSearchOutputPath,
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '/* 此文件由 src/timeline/timeline-search.ts 生成，请勿直接编辑。 */' },
  logLevel: 'info',
});

await rm(outputRoot, { recursive: true, force: true });
await mkdir(path.dirname(outputRoot), { recursive: true });
await cp(extensionRoot, outputRoot, { recursive: true });

const entryPoints = await collectJavaScriptFiles(extensionRoot);
await build({
  entryPoints,
  outbase: extensionRoot,
  outdir: outputRoot,
  bundle: false,
  platform: 'browser',
  target: 'es2022',
  sourcemap: 'linked',
  legalComments: 'none',
  logLevel: 'info',
});

console.log(`已迁移 1 个 TypeScript 模块，并生成 ${entryPoints.length} 个 JavaScript 文件：${path.relative(repositoryRoot, outputRoot)}`);
