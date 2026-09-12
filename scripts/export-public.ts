import { parseArgs } from 'node:util';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { openSqliteVault } from '../packages/adapters/filesystem/sqlite-workspace.js';
import { configureEmbeddingFromFile } from '../packages/adapters/embedding-http/config.js';
import { exportPublicBundle } from '../packages/adapters/public-snapshot/export.js';

const { values } = parseArgs({ options: { vault: { type: 'string', default: 'fixtures/showcase' }, manifest: { type: 'string', default: 'configs/public-demo.json' }, output: { type: 'string', default: 'fixtures/showcase.precomputed.json' }, 'state-dir': { type: 'string', default: '.ripple/public-demo' }, embedding: { type: 'string' }, index: { type: 'boolean', default: false } } });
const manifest = JSON.parse(await readFile(values.manifest, 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.documents)) throw new Error('Invalid public manifest');
const workspace = await openSqliteVault(resolve(values.vault), { stateDir: resolve(values['state-dir']), allMarkdown: true });
try {
  if (values.embedding) { await configureEmbeddingFromFile(workspace.service, values.embedding, values.vault); if (values.index) console.log(await workspace.service.indexEmbeddings()); }
  const byPath = new Map(workspace.service.listDocuments().map(d => [d.path, d.id]));
  const documents = manifest.documents.map((entry: { path: string; slug: string }) => { const id = byPath.get(entry.path); if (!id) throw new Error(`Allowlisted document missing: ${entry.path}`); return { id, slug: entry.slug }; });
  const bundle = exportPublicBundle(workspace.service, { title: manifest.title, id: manifest.id, documents });
  await mkdir(dirname(resolve(values.output)), { recursive: true }); await writeFile(values.output, JSON.stringify(bundle, null, 2) + '\n');
  console.log(JSON.stringify({ output: values.output, documents: bundle.documents.length, semanticPairs: bundle.semantic?.signals.length ?? 0, textChangedBeforeExport: bundle.semantic?.omittedChangedDocuments ?? 0 }));
} finally { workspace.close(); }
