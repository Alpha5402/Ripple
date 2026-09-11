import { readdir, readFile, lstat } from 'node:fs/promises';
import { resolve, relative, join, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { DocumentInput } from '../../core/model.js';

export interface VaultReadResult {
  inputs: DocumentInput[];
  files: { path: string; hash: string; bytes: number }[];
  warnings: string[];
}
/** Strictly read-only; preserves vault-relative paths used by explicit WikiLinks. */
export async function readVault(root: string, options: { allMarkdown?: boolean } = {}): Promise<VaultReadResult> {
  const absoluteRoot = resolve(root);
  const wikiExists = await lstat(join(absoluteRoot, 'Wiki')).then(s => s.isDirectory(), () => false);
  const scanRoot = !options.allMarkdown && wikiExists ? join(absoluteRoot, 'Wiki') : absoluteRoot;
  const result: VaultReadResult = { inputs: [], files: [], warnings: [] };
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const fullPath = join(directory, entry.name);
      const path = relative(absoluteRoot, fullPath).split(sep).join('/');
      if (entry.isSymbolicLink()) { result.warnings.push(`Skipped symlink: ${path}`); continue; }
      if (entry.isDirectory()) { await walk(fullPath); continue; }
      if (!entry.isFile() || !/\.md$/i.test(entry.name) || entry.name === 'AGENTS.md') continue;
      const bytes = await readFile(fullPath);
      const markdown = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
      result.inputs.push({ path, markdown });
      result.files.push({ path, hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
  };
  await walk(scanRoot); return result;
}
