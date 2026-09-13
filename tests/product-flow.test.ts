import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listMarkdownPaths } from '../packages/adapters/filesystem/manifest.js';
import { summarizeScope } from '../packages/ingestion/scope-preview.js';
import { listDirectoryPaths, readDirectory, type DirectoryHandle } from '../packages/workbench/browser-workspaces.js';

test('desktop import preview enumerates unreadable-as-text notes without ingesting them and skips symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(),'ripple-manifest-'));
  try {
    await mkdir(join(root,'Templates')); await mkdir(join(root,'.hidden'));
    await writeFile(join(root,'note.md'),'# Note'); await writeFile(join(root,'Templates','invalid.md'), Buffer.from([0xff]));
    await writeFile(join(root,'.hidden','secret.md'),'hidden'); await symlink(join(root,'note.md'),join(root,'alias.md'));
    const paths = await listMarkdownPaths(root);
    assert.deepEqual(paths, ['Templates/invalid.md','note.md']);
    assert.deepEqual(summarizeScope(paths,'Templates/'), { included:1,excluded:1,directories:[{path:'(根目录)',included:1,excluded:0},{path:'Templates',included:0,excluded:1}] });
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('browser preview reads names only and selected exclusions prevent later content reads', async () => {
  let reads=0;
  const file = (name:string) => ({kind:'file' as const,name,async getFile(){reads++; return {size:1,text:async()=> '# note'} as File;}});
  const directory = (name:string,children:(DirectoryHandle | ReturnType<typeof file>)[]): DirectoryHandle => ({kind:'directory',name,async *values(){yield* children;},isSameEntry:async()=>false,queryPermission:async()=> 'granted',requestPermission:async()=> 'granted'});
  const root=directory('vault',[file('note.md'),directory('Templates',[file('draft.md')])]);
  const paths=await listDirectoryPaths(root); assert.equal(reads,0);
  assert.equal(summarizeScope(paths,'Templates/').excluded,1);
  assert.deepEqual((await readDirectory(root,'Templates/')).map(d=>d.path),['note.md']); assert.equal(reads,1);
});

test('scope counts apply ordered gitignore exceptions and retain nested directory counts', () => {
  const result=summarizeScope(['drafts/a.md','drafts/keep.md','Wiki/a.md','Wiki/sub/b.md'],'drafts/*\n!drafts/keep.md');
  assert.equal(result.included,3);assert.equal(result.excluded,1);
  assert.equal(result.directories.find(d=>d.path==='Wiki')?.included,2);
  assert.deepEqual(result.directories.find(d=>d.path==='drafts'),{path:'drafts',included:1,excluded:1});
});
