import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const extensionRoot = path.join(repositoryRoot, 'extension');

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: repositoryRoot, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) resolve();
      else reject(new Error(`node ${args.join(' ')} 退出码为 ${code}`));
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

const extensionFiles = await collectFiles(extensionRoot, '.js');
for (const file of extensionFiles) {
  await run(['--check', file]);
}

const testFiles = await collectFiles(path.join(repositoryRoot, 'tests'), '.test.js');
await run(['--test', ...testFiles]);

console.log(`语法检查（${extensionFiles.length} 个脚本）与测试均已通过。`);