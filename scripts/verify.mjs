import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const sourceExtensionRoot = path.join(repositoryRoot, 'extension');
const builtExtensionRoot = path.join(repositoryRoot, 'dist', 'extension');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: 'inherit',
      ...options,
    });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} 退出码为 ${code}`));
    });
  });
}

async function collectFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectFiles(entryPath, suffix));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(entryPath);
  }
  return files.sort();
}

async function assertSameFile(relativePath) {
  const [source, built] = await Promise.all([
    readFile(path.join(sourceExtensionRoot, relativePath)),
    readFile(path.join(builtExtensionRoot, relativePath)),
  ]);
  if (!source.equals(built)) throw new Error(`${relativePath} 在构建过程中发生了变化`);
}

const testFiles = await collectFiles(path.join(repositoryRoot, 'tests'), '.test.js');

await run(process.execPath, [path.join(repositoryRoot, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit']);
await run(process.execPath, [path.join(repositoryRoot, 'scripts', 'build.mjs')]);
await assertSameFile('manifest.json');
await assertSameFile('index.html');

const builtJavaScriptFiles = await collectFiles(builtExtensionRoot, '.js');
for (const file of builtJavaScriptFiles) {
  await run(process.execPath, ['--check', file]);
}

await run(process.execPath, ['--test', ...testFiles]);
await run(process.execPath, ['--test', ...testFiles], {
  env: { ...process.env, TAB_OUT_EXTENSION_ROOT: builtExtensionRoot },
});

console.log('类型检查、构建、静态文件校验、语法检查及源码/产物测试均已通过。');
