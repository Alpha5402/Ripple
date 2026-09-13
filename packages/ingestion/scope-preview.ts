import { knowledgeFilter } from './knowledge-filter.js';
export interface FolderSelection { token: string; label: string; paths: string[]; ignoreRules: string }
/** Counts Markdown paths without reading or indexing document bodies. */
export function summarizeScope(paths: string[], rules: string) {
  const excluded = knowledgeFilter(rules);
  const directories = new Map<string, { path: string; included: number; excluded: number }>();
  let included = 0;
  for (const path of paths) {
    const omit = excluded(path); if (!omit) included++;
    const parts = path.split('/').slice(0, -1);
    const parents = parts.length ? parts.map((_,index) => parts.slice(0,index+1).join('/')) : ['(根目录)'];
    for (const parent of parents) {
      const row = directories.get(parent) ?? { path: parent, included: 0, excluded: 0 };
      if (omit) row.excluded++; else row.included++; directories.set(parent, row);
    }
  }
  return { included, excluded: paths.length - included, directories: [...directories.values()].sort((a,b) => a.path.localeCompare(b.path)) };
}
