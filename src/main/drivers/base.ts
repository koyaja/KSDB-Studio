import type {
  CellValue,
  DbKind,
  DbObject,
  ObjectType,
  ProcessInfo,
  QueryResult,
  ResultField,
  RowChange,
  ServerInfo,
  TablePage,
  TableStructure,
} from '../../shared/types';

export interface Endpoint {
  host: string;
  port: number;
}

export interface PageOptions {
  limit: number;
  offset: number;
  where?: string;
  orderBy?: { column: string; dir: 'asc' | 'desc' }[];
}

export interface CompletionSchema {
  schemas: Record<string, Record<string, string[]>>;
  defaultSchema: string;
}

export interface Batch {
  fields: ResultField[];
  rows: CellValue[][];
}

export interface Driver {
  readonly kind: DbKind;
  serverInfo(): Promise<ServerInfo>;
  close(): Promise<void>;

  listDatabases(): Promise<string[]>;
  listSchemas(db: string): Promise<string[]>;
  listObjects(db: string, schema: string): Promise<DbObject[]>;
  structure(db: string, schema: string, table: string): Promise<TableStructure>;
  ddl(db: string, schema: string, name: string, type: ObjectType, extra?: string): Promise<string>;
  completion(db: string): Promise<CompletionSchema>;

  /** Exécute un script dans une session dédiée (onglet de requête). */
  execute(sessionId: string, db: string, statements: string[], maxRows: number): Promise<QueryResult[]>;
  cancel(sessionId: string): Promise<boolean>;
  closeSession(sessionId: string): Promise<void>;

  fetchPage(db: string, schema: string, table: string, opts: PageOptions): Promise<TablePage>;
  count(db: string, schema: string, table: string, where?: string): Promise<number>;
  applyChanges(db: string, schema: string, table: string, changes: RowChange[], hiddenKey?: string): Promise<number>;
  previewChanges(schema: string, table: string, changes: RowChange[], hiddenKey?: string): string[];

  processes(): Promise<ProcessInfo[]>;
  kill(id: string, mode: 'cancel' | 'terminate'): Promise<void>;

  /** Parcourt un SELECT par lots (export). */
  iterate(db: string, sql: string, batchSize: number): AsyncGenerator<Batch>;
  /** Insère des lignes par lots dans une transaction (import CSV). */
  bulkInsert(
    db: string,
    schema: string,
    table: string,
    columns: string[],
    rows: AsyncIterable<CellValue[][]>,
    opts: { truncate: boolean; onProgress?: (n: number) => void },
  ): Promise<number>;

  quoteIdent(name: string): string;
  qualified(schema: string, table: string): string;
  literal(v: CellValue): string;
}

export function normalizeValue(v: unknown): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (Buffer.isBuffer(v)) {
    const max = 4096;
    const hex = v.subarray(0, max).toString('hex');
    return '0x' + hex + (v.length > max ? '…' : '');
  }
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function normalizeRow(row: unknown[]): CellValue[] {
  const out = new Array<CellValue>(row.length);
  for (let i = 0; i < row.length; i++) out[i] = normalizeValue(row[i]);
  return out;
}

export function friendlyError(e: unknown): string {
  if (e && typeof e === 'object') {
    const err = e as { message?: string; detail?: string; hint?: string; code?: string; sqlMessage?: string };
    let msg = err.sqlMessage || err.message || String(e);
    if (err.code === 'ECONNREFUSED') msg = `Connexion refusée (${msg}). Vérifie l'hôte, le port et que le serveur écoute.`;
    if (err.code === 'ENOTFOUND') msg = `Hôte introuvable (${msg}).`;
    if (err.code === 'ETIMEDOUT') msg = `Délai de connexion dépassé (${msg}).`;
    if (err.detail) msg += `\nDétail : ${err.detail}`;
    if (err.hint) msg += `\nAstuce : ${err.hint}`;
    return msg;
  }
  return String(e);
}

/** Ligne (1-based) d'un offset de caractère dans un texte. */
export function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

export const HIDDEN_KEY = '__ksdb_rowid';
