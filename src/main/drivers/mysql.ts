import fs from 'node:fs';
import mysql from 'mysql2';
import type { Pool as PromisePool, PoolConnection as PromisePoolConnection } from 'mysql2/promise';
import type {
  CellValue,
  ColumnInfo,
  ConnectionConfig,
  DbObject,
  ForeignKeyInfo,
  IndexInfo,
  ObjectType,
  ProcessInfo,
  QueryResult,
  ResultField,
  RowChange,
  ServerInfo,
  TablePage,
  TableStructure,
} from '../../shared/types';
import { Batch, CompletionSchema, Driver, Endpoint, friendlyError, normalizeRow, normalizeValue, PageOptions } from './base';
const RAW_TYPES = (mysql as unknown as { Types: Record<number, string> }).Types;
const FRIENDLY: Record<string, string> = {
  DECIMAL: 'decimal', NEWDECIMAL: 'decimal', TINY: 'tinyint', SHORT: 'smallint', LONG: 'int', INT24: 'mediumint',
  LONGLONG: 'bigint', FLOAT: 'float', DOUBLE: 'double', TIMESTAMP: 'timestamp', DATE: 'date', NEWDATE: 'date',
  TIME: 'time', DATETIME: 'datetime', YEAR: 'year', VARCHAR: 'varchar', VAR_STRING: 'varchar', STRING: 'char',
  BIT: 'bit', JSON: 'json', ENUM: 'enum', SET: 'set', TINY_BLOB: 'tinytext', MEDIUM_BLOB: 'mediumtext',
  LONG_BLOB: 'longtext', BLOB: 'text', GEOMETRY: 'geometry', VECTOR: 'vector', NULL: 'null',
};
const TYPE_NAMES = new Proxy({} as Record<number, string>, {
  get: (_t, k) => {
    const raw = RAW_TYPES[Number(k)];
    return raw ? FRIENDLY[raw] ?? raw.toLowerCase() : undefined;
  },
});

const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

interface Session {
  conn: mysql.Connection;
  db: string;
}

type Row = Record<string, unknown>;

export class MysqlDriver implements Driver {
  readonly kind = 'mysql' as const;
  private pools = new Map<string, PromisePool>();
  private sessions = new Map<string, Session>();
  private mariadb: boolean | null = null;

  constructor(
    private cfg: ConnectionConfig,
    private endpoint: () => Promise<Endpoint>,
  ) {}

  private async options(db: string): Promise<mysql.ConnectionOptions> {
    const ep = await this.endpoint();
    let ssl: mysql.ConnectionOptions['ssl'];
    if (this.cfg.ssl.mode === 'require') ssl = { rejectUnauthorized: false };
    if (this.cfg.ssl.mode === 'verify')
      ssl = { rejectUnauthorized: true, ca: this.cfg.ssl.caPath ? fs.readFileSync(this.cfg.ssl.caPath, 'utf8') : undefined };
    return {
      host: ep.host,
      port: ep.port,
      user: this.cfg.user,
      password: this.cfg.password ?? '',
      database: db || undefined,
      ssl,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
      connectTimeout: 15000,
      multipleStatements: false,
    };
  }

  private async pool(db?: string): Promise<PromisePool> {
    const name = db ?? this.cfg.database ?? '';
    let p = this.pools.get(name);
    if (!p) {
      const raw = mysql.createPool({ ...(await this.options(name)), connectionLimit: 4, waitForConnections: true });
      if (this.cfg.readOnly) raw.on('connection', (c) => c.query('SET SESSION TRANSACTION READ ONLY'));
      p = raw.promise();
      this.pools.set(name, p);
    }
    return p;
  }

  private async q<T = Row>(db: string | undefined, sql: string, params: unknown[] = []): Promise<T[]> {
    const p = await this.pool(db);
    const [rows] = await p.query(sql, params);
    return rows as T[];
  }

  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }

  qualified(schema: string, table: string): string {
    return schema ? `${this.quoteIdent(schema)}.${this.quoteIdent(table)}` : this.quoteIdent(table);
  }

  literal(v: CellValue): string {
    if (v === null) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    return mysql.escape(v);
  }

  private async isMaria(): Promise<boolean> {
    if (this.mariadb === null) {
      const [r] = await this.q<{ v: string }>(undefined, 'SELECT VERSION() AS v');
      this.mariadb = /mariadb/i.test(r.v);
    }
    return this.mariadb;
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.q<{ v: string; c: string; u: string }>(
      undefined,
      "SELECT VERSION() AS v, @@version_comment AS c, CURRENT_USER() AS u",
    );
    this.mariadb = /mariadb/i.test(r.v + r.c);
    return { version: `${this.mariadb ? 'MariaDB' : 'MySQL'} ${r.v} (${r.c})`, currentUser: r.u };
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) s.conn.destroy();
    this.sessions.clear();
    for (const p of this.pools.values()) await p.end().catch(() => {});
    this.pools.clear();
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.q<{ Database: string }>(undefined, 'SHOW DATABASES');
    const names = rows.map((r) => r.Database);
    return [...names.filter((n) => !SYSTEM_DBS.has(n)), ...names.filter((n) => SYSTEM_DBS.has(n))];
  }

  async listSchemas(db: string): Promise<string[]> {
    return [db];
  }

  async listObjects(db: string): Promise<DbObject[]> {
    const out: DbObject[] = [];
    const tables = await this.q<{ n: string; t: string }>(
      undefined,
      'SELECT TABLE_NAME AS n, TABLE_TYPE AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [db],
    );
    for (const t of tables) out.push({ name: t.n, type: /VIEW/i.test(t.t) ? 'view' : 'table' });
    const routines = await this.q<{ n: string; t: string }>(
      undefined,
      'SELECT ROUTINE_NAME AS n, ROUTINE_TYPE AS t FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = ? ORDER BY ROUTINE_NAME',
      [db],
    );
    for (const r of routines) out.push({ name: r.n, type: r.t === 'PROCEDURE' ? 'procedure' : 'function' });
    const triggers = await this.q<{ n: string; t: string }>(
      undefined,
      'SELECT TRIGGER_NAME AS n, EVENT_OBJECT_TABLE AS t FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = ? ORDER BY TRIGGER_NAME',
      [db],
    );
    for (const t of triggers) out.push({ name: t.n, type: 'trigger', extra: t.t });
    return out;
  }

  async structure(db: string, _schema: string, table: string): Promise<TableStructure> {
    const maria = await this.isMaria();
    const cols = await this.q<Row>(
      undefined,
      `SELECT COLUMN_NAME n, COLUMN_TYPE t, IS_NULLABLE nl, COLUMN_DEFAULT d, COLUMN_COMMENT c, COLUMN_KEY k,
              EXTRA x, ORDINAL_POSITION p, DATA_TYPE dt
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [db, table],
    );
    const columns: ColumnInfo[] = cols.map((c) => {
      let def = c.d === null || c.d === undefined ? null : String(c.d);
      const extra = String(c.x ?? '');
      if (def !== null) {
        if (maria) {
          if (def === 'NULL') def = null;
        } else if (!/DEFAULT_GENERATED/i.test(extra)) {
          const numeric = /int|decimal|float|double|bit|year/i.test(String(c.dt));
          if (!(numeric && /^-?[\d.]+$/.test(def))) def = mysql.escape(def);
        }
      }
      return {
        name: String(c.n),
        type: String(c.t),
        nullable: c.nl === 'YES',
        default: def,
        comment: c.c ? String(c.c) : null,
        isPrimaryKey: c.k === 'PRI',
        autoIncrement: /auto_increment/i.test(extra),
        position: Number(c.p),
      };
    });
    const stats = await this.q<{ n: string; c: string; u: number; s: number }>(
      undefined,
      `SELECT INDEX_NAME n, COLUMN_NAME c, NON_UNIQUE u, SEQ_IN_INDEX s FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [db, table],
    );
    const idxMap = new Map<string, IndexInfo>();
    for (const s of stats) {
      let i = idxMap.get(s.n);
      if (!i) idxMap.set(s.n, (i = { name: s.n, columns: [], unique: Number(s.u) === 0, primary: s.n === 'PRIMARY' }));
      i.columns.push(s.c ?? '(expression)');
    }
    const indexes = [...idxMap.values()];
    const fkRows = await this.q<Row>(
      undefined,
      `SELECT k.CONSTRAINT_NAME n, k.COLUMN_NAME c, k.REFERENCED_TABLE_SCHEMA rs, k.REFERENCED_TABLE_NAME rt,
              k.REFERENCED_COLUMN_NAME rc, r.UPDATE_RULE ur, r.DELETE_RULE dr
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [db, table],
    );
    const fkMap = new Map<string, ForeignKeyInfo>();
    for (const f of fkRows) {
      const name = String(f.n);
      let fk = fkMap.get(name);
      if (!fk)
        fkMap.set(
          name,
          (fk = {
            name,
            columns: [],
            refSchema: String(f.rs),
            refTable: String(f.rt),
            refColumns: [],
            onUpdate: String(f.ur),
            onDelete: String(f.dr),
          }),
        );
      fk.columns.push(String(f.c));
      fk.refColumns.push(String(f.rc));
    }
    const [t] = await this.q<{ c: string }>(
      undefined,
      'SELECT TABLE_COMMENT c FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [db, table],
    );
    const pk = idxMap.get('PRIMARY')?.columns ?? [];
    return {
      columns,
      indexes,
      foreignKeys: [...fkMap.values()],
      primaryKey: pk,
      primaryKeyName: pk.length ? 'PRIMARY' : undefined,
      comment: t?.c || null,
    };
  }

  async ddl(db: string, _schema: string, name: string, type: ObjectType): Promise<string> {
    const q = this.qualified(db, name);
    const what: Record<string, [string, string]> = {
      table: ['TABLE', 'Create Table'],
      view: ['VIEW', 'Create View'],
      function: ['FUNCTION', 'Create Function'],
      procedure: ['PROCEDURE', 'Create Procedure'],
      trigger: ['TRIGGER', 'SQL Original Statement'],
    };
    const [kw, col] = what[type] ?? what.table;
    const [r] = await this.q<Row>(undefined, `SHOW CREATE ${kw} ${q}`);
    const text = String(r?.[col] ?? Object.values(r ?? {})[1] ?? '');
    return text.trim() + ';\n';
  }

  async completion(db: string): Promise<CompletionSchema> {
    const rows = await this.q<{ t: string; c: string }>(
      undefined,
      `SELECT TABLE_NAME t, COLUMN_NAME c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME, ORDINAL_POSITION LIMIT 50000`,
      [db],
    );
    const tables: Record<string, string[]> = {};
    for (const r of rows) (tables[r.t] ??= []).push(r.c);
    return { schemas: { [db]: tables }, defaultSchema: db };
  }

  private async session(sessionId: string, db: string): Promise<mysql.Connection> {
    const s = this.sessions.get(sessionId);
    if (s && s.db === db) return s.conn;
    if (s) {
      s.conn.destroy();
      this.sessions.delete(sessionId);
    }
    const conn = mysql.createConnection(await this.options(db));
    await new Promise<void>((res, rej) => conn.connect((err) => (err ? rej(err) : res())));
    conn.on('error', () => this.sessions.delete(sessionId));
    if (this.cfg.readOnly) await new Promise((r) => conn.query('SET SESSION TRANSACTION READ ONLY', r));
    this.sessions.set(sessionId, { conn, db });
    return conn;
  }

  private runOne(conn: mysql.Connection, stmt: string, maxRows: number): Promise<QueryResult> {
    const t0 = performance.now();
    return new Promise((resolve) => {
      let fields: ResultField[] | null = null;
      const rows: CellValue[][] = [];
      let count = 0;
      let affected: number | undefined;
      let resultSets = 0;
      const q = conn.query({ sql: stmt, rowsAsArray: true });
      q.on('fields', (f: mysql.FieldPacket[] | undefined) => {
        if (!f) return;
        resultSets++;
        if (!fields) fields = f.map((x) => ({ name: x.name, type: TYPE_NAMES[x.columnType ?? x.type ?? -1] }));
      });
      q.on('result', (r: unknown) => {
        if (Array.isArray(r)) {
          if (resultSets > 1) return;
          count++;
          if (rows.length < maxRows) rows.push(normalizeRow(r));
        } else if (r && typeof r === 'object' && 'affectedRows' in r) {
          affected = (affected ?? 0) + Number((r as { affectedRows: number }).affectedRows);
        }
      });
      q.on('error', (e: Error) => {
        resolve({
          statement: stmt,
          fields: [],
          rows: [],
          rowCount: 0,
          durationMs: performance.now() - t0,
          error: friendlyError(e),
        });
      });
      q.on('end', () => {
        resolve({
          statement: stmt,
          fields: fields ?? [],
          rows,
          rowCount: count,
          truncated: count > maxRows,
          affectedRows: affected,
          durationMs: performance.now() - t0,
          command: stmt.trim().split(/\s+/)[0]?.toUpperCase(),
        });
      });
    });
  }

  async execute(sessionId: string, db: string, statements: string[], maxRows: number): Promise<QueryResult[]> {
    const conn = await this.session(sessionId, db);
    const out: QueryResult[] = [];
    for (const stmt of statements) {
      const r = await this.runOne(conn, stmt, maxRows);
      out.push(r);
      if (r.error) break;
    }
    return out;
  }

  async cancel(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    await this.q(undefined, `KILL QUERY ${Number(s.conn.threadId)}`);
    return true;
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) s.conn.destroy();
    this.sessions.delete(sessionId);
  }

  async fetchPage(db: string, _schema: string, table: string, opts: PageOptions): Promise<TablePage> {
    const st = await this.structure(db, db, table);
    const [t] = await this.q<{ t: string }>(
      undefined,
      'SELECT TABLE_TYPE t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [db, table],
    );
    const isTable = !/VIEW/i.test(t?.t ?? '');
    let key = st.primaryKey;
    if (!key.length) {
      const nn = new Set(st.columns.filter((c) => !c.nullable).map((c) => c.name));
      const uq = st.indexes.find((i) => i.unique && i.columns.every((c) => nn.has(c)));
      if (uq) key = uq.columns;
    }
    let sql = `SELECT * FROM ${this.qualified(db, table)}`;
    if (opts.where?.trim()) sql += ` WHERE ${opts.where}`;
    if (opts.orderBy?.length)
      sql += ' ORDER BY ' + opts.orderBy.map((o) => `${this.quoteIdent(o.column)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
    else if (key.length) sql += ' ORDER BY ' + key.map((k) => this.quoteIdent(k)).join(', ');
    sql += ` LIMIT ${Math.max(1, opts.limit | 0)} OFFSET ${Math.max(0, opts.offset | 0)}`;
    const t0 = performance.now();
    const p = await this.pool(db);
    const [rows, fields] = await p.query({ sql, rowsAsArray: true });
    let readOnlyReason: string | undefined;
    if (!isTable) readOnlyReason = 'Vue non modifiable';
    else if (!key.length) readOnlyReason = 'Pas de clé primaire ni d’index unique : édition désactivée';
    else if (this.cfg.readOnly) readOnlyReason = 'Connexion en lecture seule';
    return {
      fields: (fields as mysql.FieldPacket[]).map((f) => ({ name: f.name, type: TYPE_NAMES[f.columnType ?? f.type ?? -1] })),
      rows: (rows as unknown[][]).map(normalizeRow),
      keyColumns: key,
      editable: !readOnlyReason,
      readOnlyReason,
      sql,
      durationMs: performance.now() - t0,
    };
  }

  async count(db: string, _schema: string, table: string, where?: string): Promise<number> {
    const [r] = await this.q<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM ${this.qualified(db, table)}${where?.trim() ? ` WHERE ${where}` : ''}`,
    );
    return Number(r.n);
  }

  private buildChange(db: string, table: string, ch: RowChange, lit: boolean): { sql: string; params: unknown[] } {
    const t = this.qualified(db, table);
    const params: unknown[] = [];
    const ph = (v: CellValue) => {
      if (lit) return this.literal(v);
      params.push(v);
      return '?';
    };
    const where = (key: Record<string, CellValue>) =>
      Object.entries(key)
        .map(([k, v]) => (v === null ? `${this.quoteIdent(k)} IS NULL` : `${this.quoteIdent(k)} = ${ph(v)}`))
        .join(' AND ');
    if (ch.type === 'update') {
      const set = Object.entries(ch.set)
        .map(([k, v]) => `${this.quoteIdent(k)} = ${ph(v)}`)
        .join(', ');
      return { sql: `UPDATE ${t} SET ${set} WHERE ${where(ch.key)} LIMIT 1`, params };
    }
    if (ch.type === 'delete') return { sql: `DELETE FROM ${t} WHERE ${where(ch.key)} LIMIT 1`, params };
    const cols = Object.keys(ch.values);
    return {
      sql: `INSERT INTO ${t} (${cols.map((c) => this.quoteIdent(c)).join(', ')}) VALUES (${cols.map((c) => ph(ch.values[c])).join(', ')})`,
      params,
    };
  }

  previewChanges(schema: string, table: string, changes: RowChange[]): string[] {
    return changes.map((c) => this.buildChange(schema, table, c, true).sql + ';');
  }

  async applyChanges(db: string, _schema: string, table: string, changes: RowChange[]): Promise<number> {
    const p = await this.pool(db);
    const conn: PromisePoolConnection = await p.getConnection();
    let total = 0;
    try {
      await conn.beginTransaction();
      for (const ch of changes) {
        const { sql, params } = this.buildChange(db, table, ch, false);
        const [r] = await conn.query(sql, params);
        const n = Number((r as { affectedRows: number }).affectedRows);
        // MySQL renvoie 0 si la valeur était déjà identique : on vérifie l'existence via matchedRows
        const info = String((r as { info?: string }).info ?? '');
        const matched = /Rows matched:\s*(\d+)/.exec(info);
        const touched = ch.type === 'update' && matched ? Number(matched[1]) : n;
        if (ch.type !== 'insert' && touched !== 1)
          throw new Error(`${touched} ligne(s) trouvée(s) au lieu d'une seule. Modifications annulées.\n${sql}`);
        total += n;
      }
      await conn.commit();
      return total;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      conn.release();
    }
  }

  async processes(): Promise<ProcessInfo[]> {
    const rows = await this.q<Row>(undefined, 'SHOW FULL PROCESSLIST');
    return rows.map((r) => ({
      id: String(r.Id),
      user: String(r.User ?? ''),
      database: String(r.db ?? ''),
      client: String(r.Host ?? ''),
      state: [r.Command, r.State].filter(Boolean).join(' · '),
      durationSec: r.Time === null || r.Time === undefined ? null : Number(r.Time),
      query: String(r.Info ?? ''),
    }));
  }

  async kill(id: string, mode: 'cancel' | 'terminate'): Promise<void> {
    await this.q(undefined, `KILL ${mode === 'cancel' ? 'QUERY ' : ''}${Number(id)}`);
  }

  async *iterate(db: string, sql: string, batchSize: number): AsyncGenerator<Batch> {
    const conn = mysql.createConnection(await this.options(db));
    try {
      const q = conn.query({ sql, rowsAsArray: true });
      const stream = q.stream({ highWaterMark: batchSize });
      let fields: ResultField[] = [];
      q.on('fields', (f: mysql.FieldPacket[] | undefined) => {
        if (f) fields = f.map((x) => ({ name: x.name, type: TYPE_NAMES[x.columnType ?? x.type ?? -1] }));
      });
      let batch: CellValue[][] = [];
      for await (const row of stream as AsyncIterable<unknown[]>) {
        batch.push(normalizeRow(row));
        if (batch.length >= batchSize) {
          yield { fields, rows: batch };
          batch = [];
        }
      }
      if (batch.length || !fields.length) yield { fields, rows: batch };
    } finally {
      conn.destroy();
    }
  }

  async bulkInsert(
    db: string,
    _schema: string,
    table: string,
    columns: string[],
    batches: AsyncIterable<CellValue[][]>,
    opts: { truncate: boolean; onProgress?: (n: number) => void },
  ): Promise<number> {
    const conn = mysql.createConnection(await this.options(db)).promise();
    const t = this.qualified(db, table);
    const colSql = columns.map((c) => this.quoteIdent(c)).join(', ');
    let total = 0;
    try {
      await conn.beginTransaction();
      if (opts.truncate) await conn.query(`DELETE FROM ${t}`);
      for await (const batch of batches) {
        for (let i = 0; i < batch.length; i += 500) {
          const chunk = batch.slice(i, i + 500);
          await conn.query(`INSERT INTO ${t} (${colSql}) VALUES ?`, [chunk.map((r) => r.map(normalizeValue))]);
          total += chunk.length;
          opts.onProgress?.(total);
        }
      }
      await conn.commit();
      return total;
    } catch (e) {
      await conn.rollback().catch(() => {});
      throw e;
    } finally {
      await conn.end().catch(() => {});
    }
  }
}
