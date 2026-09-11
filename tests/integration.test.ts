import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openVault } from '../packages/adapters/filesystem/workspace.js';
import { readVault } from '../packages/adapters/filesystem/index.js';
import { Playground } from '../apps/playground-cli/controller.js';

test('real fixture CLI completes focus → progressive expansion → evidence → new focus → restored history', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'apps/playground-cli/main.ts', '--vault', 'fixtures/vault', '--commands', 'fixtures/demo.txt', '--ephemeral'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stdout, /Microtask \| 0\.700/);
  assert.match(child.stdout, /Async-Await \| 0\.300/);
  assert.match(child.stdout, /Promise → Microtask/);
  assert.match(child.stdout, /UTF-16/);
  assert.match(child.stdout, /> back\nFocus: Promise \| Lens: 70\.0/);
  assert.match(child.stdout, /Focus: Isolated[\s\S]*Visible: 0/);
});

test('CLI reports errors instead of silently choosing ambiguous nodes; all references bypass Lens', async () => {
  const { service } = await openVault('fixtures/vault');
  const playground = new Playground(service);
  assert.throws(() => playground.execute('focus Cache'), /ambiguous/);
  playground.execute('focus Promise'); playground.execute('lens 0');
  assert.match(playground.execute('relations').output, /Visible: 0/);
  assert.match(playground.execute('relations all').output, /All deterministic relations: 4/);
  assert.throws(() => playground.execute('lens'), /0\.\.100/);
});

test('an unavailable embedding configuration does not prevent deterministic CLI exploration with --index', () => {
  const child = spawnSync(process.execPath, ['--import', 'tsx', 'apps/playground-cli/main.ts', '--vault', 'fixtures/vault',
    '--embedding', 'fixtures/no-such-embedding-config.json', '--index', '--commands', 'fixtures/demo.txt', '--ephemeral'], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.match(child.stderr, /Deterministic knowledge remains available/);
  assert.match(child.stdout, /Promise → Microtask/);
});

test('CLI process restart restores the earlier focus and frozen Lens through durable identity and session files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ripple-cli-restart-'));
  try {
    const firstCommands = join(directory, 'first.txt'), secondCommands = join(directory, 'second.txt');
    await writeFile(firstCommands, 'focus Promise\nlens 70\nfocus Microtask\nquit\n');
    await writeFile(secondCommands, 'back\nquit\n');
    for (const commands of [firstCommands, secondCommands]) {
      const child = spawnSync(process.execPath, ['--import', 'tsx', 'apps/playground-cli/main.ts', '--vault', 'fixtures/vault', '--state-dir', join(directory, 'state'), '--commands', commands], { encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr + child.stdout);
      if (commands === secondCommands) {
        assert.match(child.stdout, /Focus: Promise \| Lens: 70\.0 \| threshold: 0\.300 \| current/);
        assert.match(child.stdout, /Visible: 4/);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('durable manifests preserve identity, revisions and user intent while rebuilding derived indexes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ripple-workspace-'));
  try {
    const vault = join(directory, 'vault'), stateDir = join(directory, 'state');
    await mkdir(vault);
    await writeFile(join(vault, 'Alpha.md'), '# Alpha\nBeta');
    await writeFile(join(vault, 'Beta.md'), '# Beta');
    const first = await openVault(vault, { stateDir });
    const alpha = first.service.resolveEntity('Alpha').candidates[0]!.documentId;
    const beta = first.service.resolveEntity('Beta').candidates[0]!.documentId;
    first.service.setRelationOverride(alpha, beta, { hidden: true, note: '用户整理' });
    const snapshot = first.service.createExplorationSnapshot(alpha);
    await first.save();
    const second = await openVault(vault, { stateDir });
    assert.equal(second.service.resolveEntity('Alpha').candidates[0]!.documentId, alpha);
    assert.equal(second.service.getNode(alpha)!.revision, 1);
    assert.equal(second.service.getRelations(alpha).length, 0);
    assert.equal(second.service.getVisibleRelations(snapshot).status, 'current');
    assert.equal(second.service.getRelations(alpha, { includeHidden: true })[0]!.override.note, '用户整理');
    await writeFile(join(vault, 'Alpha.md'), '# Alpha\nBeta\nChanged');
    const third = await openVault(vault, { stateDir });
    assert.equal(third.service.getNode(alpha)!.revision, 2);
    assert.equal(third.service.getVisibleRelations(snapshot).status, 'invalid');
    assert.deepEqual((await readdir(stateDir)).sort(), ['manifest.json', 'user-relations.json']);
    const manifestText = await readFile(join(stateDir, 'manifest.json'), 'utf8');
    assert.ok(!manifestText.includes('markdown'));
    assert.ok(!manifestText.includes('candidateSet'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('vault import uses Wiki paths, skips sources/symlinks, preserves BOM and refuses state inside source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ripple-vault-'));
  try {
    await mkdir(join(directory, 'Wiki')); await mkdir(join(directory, 'Sources'));
    const markdown = '\uFEFF# BOM\r\n\r\n正文';
    await writeFile(join(directory, 'Wiki/BOM.md'), markdown);
    await writeFile(join(directory, 'Sources/Raw.md'), '# Raw');
    await symlink(join(directory, 'Sources/Raw.md'), join(directory, 'Wiki/Linked.md'));
    const files = await readVault(directory);
    assert.equal(files.inputs.length, 1);
    assert.equal(files.inputs[0]!.path, 'Wiki/BOM.md');
    assert.equal(files.inputs[0]!.markdown, markdown);
    assert.deepEqual(files.warnings, ['Skipped symlink: Wiki/Linked.md']);
    await assert.rejects(openVault(directory, { stateDir: join(directory, '.ripple') }), /outside/);
    await assert.rejects(openVault(directory, { stateDir: join(directory, '..state') }), /outside/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('core and SDK dependency graph is portable and never imports adapters, Node, UI or host libraries', async () => {
  const scan = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true });
    const lists = await Promise.all(entries.map(entry => entry.isDirectory() ? scan(join(directory, entry.name)) : Promise.resolve(entry.name.endsWith('.ts') ? [join(directory, entry.name)] : [])));
    return lists.flat();
  };
  for (const file of await scan(resolve('packages/core')).then(async core => [...core, ...await scan(resolve('packages/sdk'))])) {
    const code = await readFile(file, 'utf8');
    for (const match of code.matchAll(/(?:from\s+|import\s*\()['"]([^'"\n]+)['"]/g)) {
      assert.ok(match[1]!.startsWith('.'), `${file} imports non-portable dependency ${match[1]}`);
      assert.ok(!match[1]!.includes('adapters'), `${file} imports an adapter`);
    }
  }
});
