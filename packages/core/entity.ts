import { KernelError, type Document, type EntityDefinition, type Resolution, type Target, type UserAlias } from './model.js';

export const nameKey = (name: string): string => name.trim().normalize('NFC').toLowerCase();
export function normalizePath(path: string): string {
  const parts: string[] = [];
  if (!path || path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new KernelError('INVALID_INPUT', 'Document paths must be vault-relative');
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '..') {
      if (!parts.length) throw new KernelError('INVALID_INPUT', 'Path escapes vault');
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  if (!parts.length) throw new KernelError('INVALID_INPUT', 'Empty document path');
  return parts.join('/');
}
const pathKey = (path: string): string => path.replace(/\.md$/i, '').normalize('NFC');
const generic = new Set(['概述', '原理', '总结', '简介', '介绍', 'overview', 'summary', 'introduction']);
export function naturalNameAllowed(name: string, allowShort = false): boolean {
  if (generic.has(nameKey(name))) return false;
  return allowShort || [...name.trim()].length >= 2;
}
export class EntityIndex {
  readonly definitions: EntityDefinition[] = [];
  private names = new Map<string, EntityDefinition[]>();
  private paths = new Map<string, Document>();
  private documents = new Map<string, Document>();
  constructor(documents: Document[], aliases: UserAlias[]) {
    for (const doc of documents) {
      this.documents.set(doc.id, doc);
      this.paths.set(pathKey(doc.path), doc);
      for (const name of doc.parsed.names) this.add({ ...name, target: { documentId: doc.id }, allowShort: false });
    }
    for (const alias of aliases) {
      const doc = this.documents.get(alias.target.documentId);
      if (doc && (!alias.target.sectionId || doc.parsed.sections.some(s => s.id === alias.target.sectionId))) {
        this.add({ name: alias.name, target: alias.target, source: 'user', allowShort: alias.allowShort ?? false });
      }
    }
  }
  private add(definition: EntityDefinition): void {
    if (!definition.name.trim()) return;
    this.definitions.push(definition);
    const key = nameKey(definition.name);
    this.names.set(key, [...(this.names.get(key) ?? []), definition]);
  }
  resolveName(name: string, natural = false): Resolution {
    const definitions = this.names.get(nameKey(name)) ?? [];
    if (natural && !definitions.some(d => naturalNameAllowed(d.name, d.allowShort))) {
      return { status: 'suppressed', candidates: [], reason: 'Short or generic name' };
    }
    return this.result(definitions.map(d => d.target));
  }
  resolveLink(raw: string, sourceDocumentId?: string): Resolution {
    const hash = raw.indexOf('#');
    const documentPart = (hash < 0 ? raw : raw.slice(0, hash)).trim();
    const heading = hash < 0 ? undefined : raw.slice(hash + 1).trim();
    let result: Resolution;
    if (!documentPart && sourceDocumentId) result = this.result([{ documentId: sourceDocumentId }]);
    else if (documentPart.includes('/') || documentPart.includes('\\') || /\.md$/i.test(documentPart)) {
      try {
        const source = sourceDocumentId ? this.documents.get(sourceDocumentId) : undefined;
        const path = documentPart.startsWith('.') && source
          ? `${source.path.split('/').slice(0, -1).join('/')}/${documentPart}` : documentPart;
        const doc = this.paths.get(pathKey(normalizePath(path)));
        result = this.result(doc ? [{ documentId: doc.id }] : []);
      } catch { result = this.result([]); }
    } else result = this.resolveName(documentPart);
    if (heading !== undefined && result.status === 'resolved') {
      const doc = this.documents.get(result.candidates[0]!.documentId);
      const sections = doc?.parsed.sections.filter(s => s.depth > 0 && nameKey(s.title) === nameKey(heading)) ?? [];
      return this.result(sections.map(s => ({ documentId: doc!.id, sectionId: s.id })));
    }
    return result;
  }
  private result(targets: Target[]): Resolution {
    const candidates = [...new Map(targets.map(t => [`${t.documentId}\0${t.sectionId ?? ''}`, t])).values()];
    return { status: candidates.length === 1 ? 'resolved' : candidates.length ? 'ambiguous' : 'missing', candidates };
  }
}
