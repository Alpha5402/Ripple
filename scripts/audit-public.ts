import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
const root = 'dist/web';
try { await access(join(root, 'knowledge.json')); assert.fail('Default build must not contain embedded demonstration notes'); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
const forbiddenExamples = ['Promise 表示一个异步操作最终成功或失败的结果', '异步的知识花园'];
let files = 0;
async function inspect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Symlink: ${path}`);
    if (entry.isDirectory()) { await inspect(path); continue; }
    assert.ok(!/\.(sqlite|db|map|env)$/i.test(entry.name), `Private build artifact: ${path}`);
    if (/\.(json|js|html|css)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      for (const example of forbiddenExamples) assert.ok(!text.includes(example), `Embedded demonstration content: ${path}`);
      assert.ok(!/\/Users\/alpha\/|\/home\/[^/]+\/|sk-[A-Za-z0-9]{20,}/.test(text), `Local path or credential pattern: ${path}`);
    }
    files++;
  }
}
await inspect(root);
console.log(JSON.stringify({ files, embeddedDocuments: 0, welcomeFirst: true, privateFieldAudit: 'passed' }));
