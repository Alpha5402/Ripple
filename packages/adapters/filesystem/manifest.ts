import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
/** Enumerate names only. Hidden directories and symlinks match the desktop ingestion policy. */
export async function listMarkdownPaths(root: string): Promise<string[]> {
  const paths: string[] = [];
  async function walk(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path + '/');
      else if (entry.isFile() && /\.md$/i.test(entry.name) && entry.name !== 'AGENTS.md') paths.push(path);
    }
  }
  await walk(root, ''); return paths.sort();
}
