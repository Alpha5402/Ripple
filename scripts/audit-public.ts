import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { PublicBundle } from '../packages/adapters/public-snapshot/model.js';
const root = 'dist/web';
const bundle = JSON.parse(await readFile(join(root, 'knowledge.json'), 'utf8')) as PublicBundle;
const manifest = JSON.parse(await readFile('configs/public-demo.json', 'utf8'));
assert.equal(bundle.id, manifest.id);
assert.equal(bundle.documents.length, manifest.documents.length);
const ids = new Set(bundle.documents.map(document => document.id));
for (const entry of manifest.documents) {
  const document = bundle.documents.find(document => document.id === entry.slug);
  assert.ok(document, `Missing public document: ${entry.slug}`);
  assert.equal(document.path, `${entry.slug}.md`);
  assert.equal(document.markdown, await readFile(join('fixtures/showcase', entry.path), 'utf8'));
}
for (const signal of bundle.semantic?.signals ?? []) {
  assert.ok(ids.has(signal.from) && ids.has(signal.to));
  for (const locator of signal.evidence) assert.ok(ids.has(locator.documentId));
}
function checkFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(apiKey|authorization|endpoint|vectors|vector|declarations|stateDir|vaultRoot)$/i.test(key), `Private field: ${key}`);
    checkFields(child);
  }
}
checkFields(bundle);
let files = 0;
async function inspect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Symlink: ${path}`);
    if (entry.isDirectory()) { await inspect(path); continue; }
    assert.ok(!/\.(sqlite|db|map|env)$/i.test(entry.name), `Private build artifact: ${path}`);
    if (/\.(json|js|html|css)$/.test(entry.name)) {
      const text = await readFile(path, 'utf8');
      assert.ok(!/\/Users\/alpha\/|\/home\/[^/]+\/|sk-[A-Za-z0-9]{20,}/.test(text), `Local path or credential pattern: ${path}`);
    }
    files++;
  }
}
await inspect(root);
console.log(JSON.stringify({ files, documents: ids.size, semanticPairs: bundle.semantic?.signals.length ?? 0, allowlistContentMatch: true, privateFieldAudit: 'passed' }));
