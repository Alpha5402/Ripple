import { createHash } from 'node:crypto';
import { endianness } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { KernelError, type KernelState } from '../../core/model.js';
import type { KnowledgeSearch, KnowledgeStorage, SearchHit, SearchOptions, StorageWriteOptions } from '../../core/ports.js';
import { MemoryStorage } from '../storage-memory/index.js';
import type { EmbeddingCache, EmbeddingSpaceCache, KnowledgeUnit } from '../../core/embedding/model.js';

const SCHEMA_VERSION = 1;
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
export const searchTerms = (text: string): string[] => [...segmenter.segment(text)].filter(s => s.isWordLike).map(s => s.segment.toLowerCase());
const quote = (text: string): string => `"${text.replaceAll('"', '""')}"`;
const identityChar = (text: string): boolean => /[\p{L}\p{N}_.$+/#:-]/u.test(text);
function exactOffset(body: string, query: string): number {
  for (let offset = body.indexOf(query); offset >= 0; offset = body.indexOf(query, offset + 1)) {
    if (!identityChar([...body.slice(0, offset)].at(-1) ?? '') && !identityChar([...body.slice(offset + query.length)][0] ?? '')) return offset;
  }
  return -1;
}
/** Full durable state commits atomically. Vectors are separate, removable derived data. */
export class SqliteStorage implements KnowledgeStorage, KnowledgeSearch {
  get storageCapabilities() { return { kind: 'sqlite', persistent: this.path !== ':memory:', concurrency: 'optimistic' as const }; }
  readonly searchCapabilities = { engine: 'sqlite-fts5/intl-zh+trigram-v1', modes: ['text', 'literal', 'exact'] as const };
  private db: DatabaseSync;
  private generation = 0;
  private closed = false;
  constructor(readonly path: string, options: { namespace?: string } = {}) {
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version !== 0 && version !== SCHEMA_VERSION) throw new KernelError('STORAGE_SCHEMA', `Unsupported SQLite schema ${version}; expected ${SCHEMA_VERSION}`);
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (!version) this.db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE storage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE metadata (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL, state_json TEXT NOT NULL);
        CREATE TABLE documents (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL, content_hash TEXT NOT NULL, markdown TEXT NOT NULL, parsed_json TEXT NOT NULL);
        CREATE TABLE revisions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, validity_epoch INTEGER NOT NULL);
        CREATE TABLE declarations (id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL);
        CREATE TABLE embedding_spaces (id TEXT PRIMARY KEY, json TEXT NOT NULL);
        CREATE TABLE vectors (space_id TEXT NOT NULL REFERENCES embedding_spaces(id) ON DELETE CASCADE, unit_id TEXT NOT NULL, document_id TEXT NOT NULL, revision INTEGER NOT NULL, content_hash TEXT NOT NULL, unit_json TEXT NOT NULL, vector BLOB NOT NULL, record_hash TEXT NOT NULL, PRIMARY KEY(space_id,unit_id));
        CREATE INDEX vectors_document ON vectors(space_id,document_id);
        CREATE VIRTUAL TABLE documents_fts USING fts5(id UNINDEXED, title, body, tokenize='unicode61 remove_diacritics 2');
        CREATE VIRTUAL TABLE documents_trigram USING fts5(id UNINDEXED, body, tokenize='trigram');
        PRAGMA user_version=1;
        COMMIT;
      `);
      if (options.namespace) {
        this.db.prepare('INSERT OR IGNORE INTO storage_meta VALUES(?,?)').run('namespace', options.namespace);
        if (this.db.prepare('SELECT value FROM storage_meta WHERE key=?').get('namespace')?.value !== options.namespace) throw new KernelError('INVALID_INPUT', 'Database belongs to another vault');
      }
      if (!this.db.prepare('SELECT id FROM metadata WHERE id=1').get()) {
        const empty = new MemoryStorage().load();
        this.save(empty);
      } else this.generation = Number(this.db.prepare('SELECT generation FROM metadata WHERE id=1').get()!.generation);
    } catch (error) { this.db.close(); throw this.error(error); }
  }
  private error(error: unknown): KernelError {
    if (error instanceof KernelError) return error;
    const code = (error as { code?: string }).code ?? '';
    return new KernelError(code.includes('BUSY') || code.includes('LOCKED') ? 'STORAGE_CONFLICT' : 'STORAGE', 'SQLite operation failed; inspect the local database and retry');
  }
  private assertOpen(): void { if (this.closed) throw new KernelError('CLOSED', 'SQLite storage is closed'); }
  private assertGeneration(): void {
    const row = this.db.prepare('SELECT generation FROM metadata WHERE id=1').get();
    if (row && Number(row.generation) !== this.generation) throw new KernelError('STORAGE_CONFLICT', 'Database changed in another kernel; reopen before retrying');
  }
  load(): KernelState {
    this.assertOpen();
    try {
      this.db.exec('BEGIN;');
      const row = this.db.prepare('SELECT generation,state_json FROM metadata WHERE id=1').get()!;
      const state = JSON.parse(String(row.state_json)) as KernelState;
      state.declarations = JSON.parse(String(this.db.prepare('SELECT json FROM declarations WHERE id=1').get()!.json));
      state.documents = this.db.prepare('SELECT * FROM documents ORDER BY rowid').all().map(row => ({ id: String(row.id), path: String(row.path), revision: Number(row.revision), contentHash: String(row.content_hash), markdown: String(row.markdown), parsed: JSON.parse(String(row.parsed_json)) }));
      state.revisions = {}; state.validityEpochs = {};
      for (const item of this.db.prepare('SELECT * FROM revisions').all()) { state.revisions[String(item.id)] = Number(item.revision); state.validityEpochs[String(item.id)] = Number(item.validity_epoch); }
      if (state.embedding) {
        const cache: EmbeddingCache = { ...state.embedding, spaces: {} };
        for (const space of this.db.prepare('SELECT * FROM embedding_spaces').all()) {
          const stored = JSON.parse(String(space.json)) as EmbeddingSpaceCache;
          stored.records = [];
          for (const record of this.db.prepare('SELECT unit_json,document_id,vector FROM vectors WHERE space_id=? ORDER BY unit_id').all(String(space.id))) {
            const bytes = record.vector as Uint8Array;
            if (bytes.byteLength !== stored.space.descriptor.dimensions * 8) {
              const status = stored.documents[String(record.document_id)];
              if (status) { status.status = 'pending'; status.readyCount = Math.max(0, status.readyCount - 1); }
              continue;
            }
            const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
            const vector = Array.from({ length: bytes.byteLength / 8 }, (_, i) => view.getFloat64(i * 8, true));
            stored.records.push({ unit: JSON.parse(String(record.unit_json)) as KnowledgeUnit, vector });
          }
          cache.spaces[String(space.id)] = stored;
        }
        state.embedding = cache;
      }
      this.db.exec('COMMIT;'); this.generation = Number(row.generation);
      return state;
    } catch (error) { try { this.db.exec('ROLLBACK;'); } catch { /* transaction already ended */ } throw this.error(error); }
  }
  save(state: KernelState, options: StorageWriteOptions = {}): void {
    this.assertOpen();
    try {
      this.db.exec('BEGIN IMMEDIATE;'); this.assertGeneration();
      const previous = new Map(this.db.prepare('SELECT rowid,id,path,revision,content_hash FROM documents').all().map(row => [String(row.id), row]));
      const current = new Set(state.documents.map(d => d.id));
      const remove = this.db.prepare('DELETE FROM documents WHERE id=?');
      const removeFts = this.db.prepare('DELETE FROM documents_fts WHERE rowid=?');
      const removeTrigram = this.db.prepare('DELETE FROM documents_trigram WHERE rowid=?');
      for (const id of previous.keys()) if (!current.has(id)) { remove.run(id); removeFts.run(Number(previous.get(id)!.rowid)); removeTrigram.run(Number(previous.get(id)!.rowid)); }
      const insert = this.db.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,revision=excluded.revision,content_hash=excluded.content_hash,markdown=excluded.markdown,parsed_json=excluded.parsed_json RETURNING rowid');
      const fts = this.db.prepare('INSERT INTO documents_fts(rowid,id,title,body) VALUES(?,?,?,?)');
      const trigram = this.db.prepare('INSERT INTO documents_trigram(rowid,id,body) VALUES(?,?,?)');
      for (const doc of state.documents) {
        const old = previous.get(doc.id);
        if (old?.path === doc.path && old.revision === doc.revision && old.content_hash === doc.contentHash) continue;
        const rowid = Number(insert.get(doc.id, doc.path, doc.revision, doc.contentHash, doc.markdown, JSON.stringify(doc.parsed))!.rowid);
        if (old) { removeFts.run(Number(old.rowid)); removeTrigram.run(Number(old.rowid)); }
        fts.run(rowid, doc.id, searchTerms(doc.parsed.title).join(' '), searchTerms(doc.markdown).join(' ')); trigram.run(rowid, doc.id, doc.markdown);
      }
      const revision = this.db.prepare('INSERT INTO revisions VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,validity_epoch=excluded.validity_epoch WHERE revision<>excluded.revision OR validity_epoch<>excluded.validity_epoch');
      for (const [id, value] of Object.entries(state.revisions)) revision.run(id, value, state.validityEpochs[id] ?? 0);
      this.db.prepare('INSERT INTO declarations VALUES(1,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json WHERE json<>excluded.json').run(JSON.stringify(state.declarations));
      if (!options.embeddingSpacesUnchanged) {
        const previousVectors = new Map(this.db.prepare('SELECT space_id,unit_id,record_hash FROM vectors').all().map(r => [JSON.stringify([r.space_id, r.unit_id]), r]));
        const currentVectors = new Set<string>();
        const vector = this.db.prepare('INSERT INTO vectors VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(space_id,unit_id) DO UPDATE SET document_id=excluded.document_id,revision=excluded.revision,content_hash=excluded.content_hash,unit_json=excluded.unit_json,vector=excluded.vector,record_hash=excluded.record_hash');
        const spaces = state.embedding?.spaces ?? {};
        for (const existing of this.db.prepare('SELECT id FROM embedding_spaces').all()) if (!Object.hasOwn(spaces, String(existing.id))) this.db.prepare('DELETE FROM embedding_spaces WHERE id=?').run(String(existing.id));
        for (const [id, space] of Object.entries(spaces)) {
          this.db.prepare('INSERT INTO embedding_spaces VALUES(?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json WHERE json<>excluded.json').run(id, JSON.stringify({ ...space, records: [] }));
          for (const record of space.records) {
            const bytes = Buffer.from(Float64Array.from(record.vector).buffer);
            if (endianness() !== 'LE') record.vector.forEach((value, i) => bytes.writeDoubleLE(value, i * 8));
            const unit = record.unit, unitJson = JSON.stringify(unit), key = JSON.stringify([id, unit.id]);
            currentVectors.add(key);
            const hash = createHash('sha256').update(unitJson).update(bytes).digest('hex');
            if (previousVectors.get(key)?.record_hash === hash) continue;
            vector.run(id, unit.id, unit.documentId, unit.revision, unit.contentHash, unitJson, bytes, hash);
          }
        }
        const removeVector = this.db.prepare('DELETE FROM vectors WHERE space_id=? AND unit_id=?');
        for (const [key, row] of previousVectors) if (!currentVectors.has(key)) removeVector.run(String(row.space_id), String(row.unit_id));
      }
      const metadata = { ...state, documents: [], revisions: {}, validityEpochs: {}, declarations: undefined,
        ...(state.embedding ? { embedding: { ...state.embedding, spaces: {} } } : {}) };
      this.db.prepare('INSERT INTO metadata VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,state_json=excluded.state_json').run(this.generation + 1, JSON.stringify(metadata));
      this.db.exec('COMMIT;'); this.generation++;
    } catch (error) { try { this.db.exec('ROLLBACK;'); } catch { /* transaction already ended */ } throw this.error(error); }
  }
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    this.assertOpen();
    try {
      this.db.exec('BEGIN;'); this.assertGeneration();
      const hits = this.querySearch(query, options);
      this.db.exec('COMMIT;'); return hits;
    } catch (error) { try { this.db.exec('ROLLBACK;'); } catch { /* transaction already ended */ } throw this.error(error); }
  }
  private querySearch(query: string, options: SearchOptions): SearchHit[] {
    const mode = options.mode ?? 'text', limit = options.limit ?? 20;
    if (!query.trim() || query.length > 512 || !Number.isInteger(limit) || limit < 1 || limit > 1000 || !['text', 'literal', 'exact'].includes(mode)) throw new KernelError('INVALID_INPUT', 'Search needs 1–512 characters, a supported mode and a limit of 1–1000');
    const terms = searchTerms(query);
    let rows;
    try {
      if (mode === 'text') {
        if (!terms.length) return [];
        rows = this.db.prepare('SELECT d.*,bm25(documents_fts,0,3,1) rank FROM documents_fts JOIN documents d ON d.id=documents_fts.id WHERE documents_fts MATCH ? ORDER BY rank,d.id LIMIT ?').all(terms.map(quote).join(' AND '), limit);
      } else if ([...query].length >= 3) {
        rows = this.db.prepare('SELECT d.*,0 rank FROM documents_trigram JOIN documents d ON d.id=documents_trigram.id WHERE documents_trigram MATCH ? AND instr(d.markdown,?)>0 ORDER BY d.id').iterate(quote(query), query);
      } else rows = this.db.prepare('SELECT *,0 rank FROM documents WHERE instr(markdown,?)>0 ORDER BY id').iterate(query);
    } catch (error) { throw this.error(error); }
    const hits: SearchHit[] = [];
    for (const row of rows) {
      const body = String(row.markdown), parsed = JSON.parse(String(row.parsed_json));
      const offset = mode === 'exact' ? exactOffset(body, query) : mode === 'literal' ? body.indexOf(query) : body.toLowerCase().indexOf(terms[0]!);
      if (mode === 'exact' && offset < 0) continue;
      const width = mode === 'text' ? terms[0]!.length : query.length;
      hits.push({ documentId: String(row.id), revision: Number(row.revision), path: String(row.path), title: parsed.title,
        score: -Number(row.rank), excerpt: body.slice(Math.max(0, offset - 80), Math.max(0, offset) + width + 120),
        ...(offset >= 0 ? { match: { start: offset, end: offset + width } } : {}) });
      if (hits.length >= limit) break;
    }
    return hits;
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
