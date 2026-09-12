import { readFile, realpath, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson } from '../adapters/filesystem/atomic-json.js';
import type { RecentWorkspace } from './contract.js';

export interface DesktopWorkspace extends RecentWorkspace { readOnly: boolean }
export class WorkspaceHistory {
  private entries: DesktopWorkspace[] = [];
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(join(this.directory, 'workspaces.json'), 'utf8'));
      if (data.version === 1 && Array.isArray(data.entries)) this.entries = data.entries.filter((e: DesktopWorkspace) => typeof e.id === 'string' && typeof e.location === 'string' && typeof e.label === 'string' && typeof e.readOnly === 'boolean' && Number.isFinite(e.lastOpened)).slice(0, 20);
    } catch { this.entries = []; }
  }
  list(): DesktopWorkspace[] { return structuredClone(this.entries); }
  async remember(root: string, readOnly: boolean): Promise<DesktopWorkspace> {
    const location = await realpath(root);
    const entry = { id: createHash('sha256').update(location).digest('hex').slice(0, 24), label: basename(location), location, readOnly, lastOpened: Date.now() };
    this.entries = [entry, ...this.entries.filter(e => e.id !== entry.id)].slice(0, 20); await this.save(); return entry;
  }
  async forget(id: string): Promise<void> { this.entries = this.entries.filter(e => e.id !== id); await this.save(); }
  private async save(): Promise<void> { await mkdir(this.directory, { recursive: true }); await atomicJson(join(this.directory, 'workspaces.json'), { version: 1, entries: this.entries }); }
}
