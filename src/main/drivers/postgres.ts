import fs from 'node:fs';
import pg from 'pg';
import Cursor from 'pg-cursor';
import { returnsRows } from '../../shared/sqlsplit';
import { normalizeSchema, SchemaSnapshot, SnapObject, SnapTable } from '../../shared/schemadiff';
import type {
  CellValue,
  ColumnInfo,
  ConnectionConfig,
  DbObject,
  ErdColumn,
  ErdModel,
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
import {
  Batch,
  CompletionSchema,
  Driver,
  Endpoint,
  friendlyError,
  HIDDEN_KEY,
  lineOf,
  normalizeRow,
  PageOptions,
} from './base';

// Dates et heures renvoyées telles quelles (pas de conversion de fuseau).
for (const oid of [1082, 1083, 1114, 1184, 1266, 1186]) pg.types.setTypeParser(oid, (v: string) => v);

const FK_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

interface Session {
  client: pg.Client;
  db: string;
}

export class PostgresDriver implements Driver {
  readonly kind = 'postgres' as const;
  private pools = new Map<string, pg.Pool>();
  private sessions = new Map<string, Session>();
  private typeNames = new Map<number, string>();

  constructor(
    private cfg: ConnectionConfig,
    private endpoint: () => Promise<Endpoint>,
  ) {}

  private async clientConfig(db: string): Promise<pg.ClientConfig> {
    const ep = await this.endpoint();
    let ssl: pg.ClientConfig['ssl'] = false;
    if (this.cfg.ssl.mode === 'require') ssl = { rejectUnauthorized: false };
    if (this.cfg.ssl.mode === 'verify')
      ssl = { rejectUnauthorized: true, ca: this.cfg.ssl.caPath ? fs.readFileSync(this.cfg.ssl.caPath, 'utf8') : undefined };
    return {
      host: ep.host,
      port: ep.port,
      user: this.cfg.user,
      password: this.cfg.password ?? '',
      database: db || this.cfg.database || 'postgres',
      ssl,
      connectionTimeoutMillis: 15000,
      application_name: 'KSDB Studio',
      options: this.cfg.readOnly ? '-c default_transaction_read_only=on' : undefined,
    };
  }

  private defaultDb(): string {
    return this.cfg.database || 'postgres';
  }

  private async pool(db?: string): Promise<pg.Pool> {
    const name = db || this.defaultDb();
    let p = this.pools.get(name);
    if (!p) {
      p = new pg.Pool({ ...(await this.clientConfig(name)), max: 4, idleTimeoutMillis: 60000 });
      p.on('error', () => {
        /* client inactif cassé : le pool le remplacera */
      });
      this.pools.set(name, p);
    }
    return p;
  }

  private async q<T = Record<string, unknown>>(db: string | undefined, sql: string, params: unknown[] = []): Promise<T[]> {
    const p = await this.pool(db);
    const r = await p.query(sql, params);
    return r.rows as T[];
  }

  quoteIdent(name: string): string {
    return '"' + name.replace(/"/g, '""') + '"';
  }

  qualified(schema: string, table: string): string {
    return schema ? `${this.quoteIdent(schema)}.${this.quoteIdent(table)}` : this.quoteIdent(table);
  }

  literal(v: CellValue): string {
    if (v === null) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return "'" + v.replace(/'/g, "''") + "'";
  }

  async serverInfo(): Promise<ServerInfo> {
    const [r] = await this.q<{ v: string; u: string }>(undefined, 'select version() v, current_user u');
    return { version: r.v, currentUser: r.u };
  }

  async close(): Promise<void> {
    for (const s of this.sessions.values()) await s.client.end().catch(() => {});
    this.sessions.clear();
    for (const p of this.pools.values()) await p.end().catch(() => {});
    this.pools.clear();
  }

  async listDatabases(): Promise<string[]> {
    const rows = await this.q<{ datname: string }>(
      undefined,
      'select datname from pg_database where not datistemplate and datallowconn order by datname',
    );
    return rows.map((r) => r.datname);
  }

  async listSchemas(db: string): Promise<string[]> {
    const rows = await this.q<{ nspname: string }>(
      db,
      `select nspname from pg_namespace
       where nspname not like 'pg\\_toast%' and nspname not like 'pg\\_temp%'
         and nspname not in ('pg_catalog','information_schema')
       order by nspname`,
    );
    return rows.map((r) => r.nspname);
  }

  async listObjects(db: string, schema: string): Promise<DbObject[]> {
    const out: DbObject[] = [];
    const rels = await this.q<{ relname: string; relkind: string }>(
      db,
      `select c.relname, c.relkind from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('r','p','v','m','S','f') order by c.relname`,
      [schema],
    );
    for (const r of rels) {
      const type: ObjectType =
        r.relkind === 'v' ? 'view' : r.relkind === 'm' ? 'matview' : r.relkind === 'S' ? 'sequence' : 'table';
      out.push({ name: r.relname, type });
    }
    let procs: { proname: string; args: string; kind: string }[] = [];
    try {
      procs = await this.q(
        db,
        `select p.proname, oidvectortypes(p.proargtypes) args, p.prokind::text kind
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = $1 and p.prokind in ('f','p')
           and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
         order by 1, 2`,
        [schema],
      );
    } catch {
      procs = await this.q(
        db,
        `select p.proname, oidvectortypes(p.proargtypes) args, 'f' kind
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 order by 1, 2`,
        [schema],
      );
    }
    for (const p of procs) out.push({ name: p.proname, type: p.kind === 'p' ? 'procedure' : 'function', extra: p.args });
    const trg = await this.q<{ tgname: string; relname: string }>(
      db,
      `select t.tgname, c.relname from pg_trigger t join pg_class c on c.oid = t.tgrelid
       join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and not t.tgisinternal order by 1`,
      [schema],
    );
    for (const t of trg) out.push({ name: t.tgname, type: 'trigger', extra: t.relname });
    return out;
  }

  async structure(db: string, schema: string, table: string): Promise<TableStructure> {
    const reg = this.qualified(schema, table);
    const cols = await this.q<{
      name: string;
      type: string;
      nullable: boolean;
      def: string | null;
      comment: string | null;
      pos: number;
      ident: string;
    }>(
      db,
      `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
              pg_get_expr(d.adbin, d.adrelid) as def, col_description(a.attrelid, a.attnum) as comment,
              a.attnum as pos, a.attidentity::text as ident
       from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
       where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
      [reg],
    );
    const pk = await this.q<{ conname: string; cols: string[] }>(
      db,
      `select con.conname, array(select a.attname from unnest(con.conkey) with ordinality k(n, o)
              join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o)::text[] as cols
       from pg_constraint con where con.conrelid = $1::regclass and con.contype = 'p'`,
      [reg],
    );
    const pkCols = pk[0]?.cols ?? [];
    const columns: ColumnInfo[] = cols.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      default: c.def,
      comment: c.comment,
      position: c.pos,
      isPrimaryKey: pkCols.includes(c.name),
      autoIncrement: c.ident === 'a' || c.ident === 'd' || /^nextval\(/i.test(c.def ?? ''),
    }));
    const idx = await this.q<{ name: string; uniq: boolean; prim: boolean; def: string; cols: string[] }>(
      db,
      `select i.relname as name, ix.indisunique as uniq, ix.indisprimary as prim, pg_get_indexdef(ix.indexrelid) as def,
              array(select pg_get_indexdef(ix.indexrelid, k, true) from generate_series(1, ix.indnatts) k order by k)::text[] as cols
       from pg_index ix join pg_class i on i.oid = ix.indexrelid where ix.indrelid = $1::regclass order by 1`,
      [reg],
    );
    const indexes: IndexInfo[] = idx.map((i) => ({
      name: i.name,
      unique: i.uniq,
      primary: i.prim,
      columns: i.cols,
      definition: i.def,
    }));
    const fks = await this.q<{
      name: string;
      cols: string[];
      ref_schema: string;
      ref_table: string;
      ref_cols: string[];
      upd: string;
      del: string;
    }>(
      db,
      `select con.conname as name,
              array(select a.attname from unnest(con.conkey) with ordinality k(n, o)
                    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o)::text[] as cols,
              rn.nspname as ref_schema, rc.relname as ref_table,
              array(select a.attname from unnest(con.confkey) with ordinality k(n, o)
                    join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.o)::text[] as ref_cols,
              con.confupdtype::text as upd, con.confdeltype::text as del
       from pg_constraint con join pg_class rc on rc.oid = con.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
       where con.conrelid = $1::regclass and con.contype = 'f' order by 1`,
      [reg],
    );
    const foreignKeys: ForeignKeyInfo[] = fks.map((f) => ({
      name: f.name,
      columns: f.cols,
      refSchema: f.ref_schema,
      refTable: f.ref_table,
      refColumns: f.ref_cols,
      onUpdate: FK_ACTIONS[f.upd] ?? f.upd,
      onDelete: FK_ACTIONS[f.del] ?? f.del,
    }));
    const [c] = await this.q<{ c: string | null }>(db, `select obj_description($1::regclass, 'pg_class') c`, [reg]);
    return { columns, indexes, foreignKeys, primaryKey: pkCols, primaryKeyName: pk[0]?.conname, comment: c?.c ?? null };
  }

  async ddl(db: string, schema: string, name: string, type: ObjectType, extra?: string): Promise<string> {
    const reg = this.qualified(schema, name);
    if (type === 'view' || type === 'matview') {
      const [r] = await this.q<{ d: string }>(db, 'select pg_get_viewdef($1::regclass, true) d', [reg]);
      const kw = type === 'view' ? 'CREATE OR REPLACE VIEW' : 'CREATE MATERIALIZED VIEW';
      return `${kw} ${reg} AS\n${r.d}`;
    }
    if (type === 'function' || type === 'procedure') {
      const [r] = await this.q<{ d: string }>(db, 'select pg_get_functiondef($1::regprocedure) d', [
        `${reg}(${extra ?? ''})`,
      ]);
      return r.d.trim() + ';';
    }
    if (type === 'trigger') {
      const [r] = await this.q<{ d: string }>(
        db,
        `select pg_get_triggerdef(t.oid, true) d from pg_trigger t where t.tgname = $1 and t.tgrelid = $2::regclass`,
        [name, this.qualified(schema, extra ?? '')],
      );
      return r.d + ';';
    }
    if (type === 'sequence') {
      const [s] = await this.q<Record<string, string | boolean>>(
        db,
        `select data_type::text, start_value, min_value, max_value, increment_by, cycle, cache_size
         from pg_sequences where schemaname = $1 and sequencename = $2`,
        [schema, name],
      );
      return (
        `CREATE SEQUENCE ${reg}\n  AS ${s.data_type}\n  INCREMENT BY ${s.increment_by}\n  MINVALUE ${s.min_value}\n` +
        `  MAXVALUE ${s.max_value}\n  START WITH ${s.start_value}\n  CACHE ${s.cache_size}${s.cycle ? '\n  CYCLE' : ''};`
      );
    }
    return this.tableDdl(db, schema, name);
  }

  private async tableDdl(db: string, schema: string, name: string): Promise<string> {
    const reg = this.qualified(schema, name);
    const st = await this.structure(db, schema, name);
    const identity = await this.q<{ name: string; ident: string }>(
      db,
      `select attname as name, attidentity::text as ident from pg_attribute
       where attrelid = $1::regclass and attnum > 0 and not attisdropped and attidentity <> ''`,
      [reg],
    );
    const identMap = new Map(identity.map((i) => [i.name, i.ident]));
    const lines = st.columns.map((c) => {
      let l = `  ${this.quoteIdent(c.name)} ${c.type}`;
      const id = identMap.get(c.name);
      if (id) l += ` GENERATED ${id === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
      else if (c.default !== null) l += ` DEFAULT ${c.default}`;
      if (!c.nullable) l += ' NOT NULL';
      return l;
    });
    const cons = await this.q<{ conname: string; def: string }>(
      db,
      `select conname, pg_get_constraintdef(oid, true) def from pg_constraint
       where conrelid = $1::regclass order by contype <> 'p', contype, conname`,
      [reg],
    );
    for (const c of cons) lines.push(`  CONSTRAINT ${this.quoteIdent(c.conname)} ${c.def}`);
    let out = `CREATE TABLE ${reg} (\n${lines.join(',\n')}\n);\n`;
    const idx = await this.q<{ def: string }>(
      db,
      `select pg_get_indexdef(ix.indexrelid) def from pg_index ix
       where ix.indrelid = $1::regclass and not exists (select 1 from pg_constraint c where c.conindid = ix.indexrelid)
       order by 1`,
      [reg],
    );
    for (const i of idx) out += `\n${i.def};`;
    if (st.comment) out += `\n\nCOMMENT ON TABLE ${reg} IS ${this.literal(st.comment)};`;
    for (const c of st.columns)
      if (c.comment) out += `\nCOMMENT ON COLUMN ${reg}.${this.quoteIdent(c.name)} IS ${this.literal(c.comment)};`;
    const trg = await this.q<{ d: string }>(
      db,
      `select pg_get_triggerdef(oid, true) d from pg_trigger where tgrelid = $1::regclass and not tgisinternal order by tgname`,
      [reg],
    );
    for (const t of trg) out += `\n\n${t.d};`;
    return out.trim() + '\n';
  }

  async snapshot(db: string, schema: string): Promise<SchemaSnapshot> {
    const rel = `n.nspname = $1 and c.relkind in ('r','p') and not c.relispartition`;
    const [tbls, cols, pks, idx, fks, views, routines, triggers, deps] = await Promise.all([
      this.q<{ t: string; comment: string | null }>(
        db,
        `select c.relname t, obj_description(c.oid, 'pg_class') as comment from pg_class c
         join pg_namespace n on n.oid = c.relnamespace where ${rel} order by 1`,
        [schema],
      ),
      this.q<{ t: string; name: string; type: string; nullable: boolean; def: string | null; ident: string; comment: string | null }>(
        db,
        `select c.relname t, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
                pg_get_expr(d.adbin, d.adrelid) as def, a.attidentity::text as ident, col_description(a.attrelid, a.attnum) as comment
         from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
         left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
         where ${rel} and a.attnum > 0 and not a.attisdropped order by c.relname, a.attnum`,
        [schema],
      ),
      this.q<{ t: string; name: string; cols: string[] }>(
        db,
        `select c.relname t, con.conname as name,
                array(select a.attname from unnest(con.conkey) with ordinality k(n, o)
                      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o)::text[] as cols
         from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
         where ${rel} and con.contype = 'p'`,
        [schema],
      ),
      this.q<{ t: string; name: string; uniq: boolean; def: string; cols: string[]; con: string | null }>(
        db,
        `select c.relname t, i.relname as name, ix.indisunique as uniq, pg_get_indexdef(ix.indexrelid) as def,
                array(select pg_get_indexdef(ix.indexrelid, k, true) from generate_series(1, ix.indnatts) k order by k)::text[] as cols,
                (select con.contype::text from pg_constraint con where con.conindid = ix.indexrelid and con.conrelid = c.oid limit 1) as con
         from pg_index ix join pg_class i on i.oid = ix.indexrelid join pg_class c on c.oid = ix.indrelid
         join pg_namespace n on n.oid = c.relnamespace
         where ${rel} and not ix.indisprimary order by 1, 2`,
        [schema],
      ),
      this.q<{ name: string; t: string; cols: string[]; rs: string; rt: string; rcols: string[]; upd: string; del: string }>(
        db,
        `select con.conname as name, c.relname as t,
                array(select a.attname from unnest(con.conkey) with ordinality k(n, o)
                      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o)::text[] as cols,
                rn.nspname as rs, rc.relname as rt,
                array(select a.attname from unnest(con.confkey) with ordinality k(n, o)
                      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.o)::text[] as rcols,
                con.confupdtype::text as upd, con.confdeltype::text as del
         from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
         join pg_class rc on rc.oid = con.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
         where ${rel} and con.contype = 'f' order by 2, 1`,
        [schema],
      ),
      this.q<{ name: string; kind: string; def: string }>(
        db,
        `select c.relname as name, c.relkind::text as kind, pg_get_viewdef(c.oid, true) as def
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind in ('v','m') order by 1`,
        [schema],
      ),
      this.q<{ name: string; args: string; kind: string; def: string }>(
        db,
        `select p.proname as name, oidvectortypes(p.proargtypes) as args, p.prokind::text as kind, pg_get_functiondef(p.oid) as def
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = $1 and p.prokind in ('f','p')
           and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
         order by 1, 2`,
        [schema],
      ).catch(() => [] as { name: string; args: string; kind: string; def: string }[]),
      this.q<{ name: string; t: string; def: string }>(
        db,
        `select t.tgname as name, c.relname as t, pg_get_triggerdef(t.oid, true) as def
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and not t.tgisinternal order by 2, 1`,
        [schema],
      ),
      this.q<{ v: string; d: string }>(
        db,
        `select distinct v.relname as v, d.relname as d
         from pg_rewrite r join pg_class v on v.oid = r.ev_class join pg_namespace n on n.oid = v.relnamespace
         join pg_depend dp on dp.objid = r.oid and dp.classid = 'pg_rewrite'::regclass
         join pg_class d on d.oid = dp.refobjid join pg_namespace dn on dn.oid = d.relnamespace
         where n.nspname = $1 and dn.nspname = $1 and v.relkind in ('v','m') and d.oid <> v.oid`,
        [schema],
      ),
    ]);
    const depsOf = new Map<string, string[]>();
    for (const r of deps) (depsOf.get(r.v) ?? depsOf.set(r.v, []).get(r.v)!).push(r.d);
    const norm = (s: string) => normalizeSchema(s, schema);
    const group = <T extends { t: string }>(rows: T[]) => {
      const m = new Map<string, T[]>();
      for (const r of rows) (m.get(r.t) ?? m.set(r.t, []).get(r.t)!).push(r);
      return m;
    };
    const colsBy = group(cols);
    const idxBy = group(idx);
    const fkBy = group(fks);
    const pkBy = new Map(pks.map((p) => [p.t, p]));
    const tables: SnapTable[] = tbls.map((t) => ({
      name: t.t,
      comment: t.comment,
      columns: (colsBy.get(t.t) ?? []).map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        default: c.def === null ? null : norm(c.def),
        identity: c.ident ?? '',
        comment: c.comment,
      })),
      pk: pkBy.has(t.t) ? { name: pkBy.get(t.t)!.name, columns: pkBy.get(t.t)!.cols } : null,
      indexes: (idxBy.get(t.t) ?? [])
        .filter((i) => i.con !== 'p' && i.con !== 'x')
        .map((i) => ({ name: i.name, unique: i.uniq, columns: i.cols, def: norm(i.def), constraint: i.con === 'u' })),
      fks: (fkBy.get(t.t) ?? []).map((f) => ({
        name: f.name,
        columns: f.cols,
        refSchema: f.rs === schema ? null : f.rs,
        refTable: f.rt,
        refColumns: f.rcols,
        onUpdate: FK_ACTIONS[f.upd] ?? f.upd,
        onDelete: FK_ACTIONS[f.del] ?? f.del,
      })),
    }));
    const objects: SnapObject[] = [
      ...views.map((v) => ({
        name: v.name,
        key: v.name,
        kind: (v.kind === 'm' ? 'matview' : 'view') as SnapObject['kind'],
        def: `${v.kind === 'm' ? 'CREATE MATERIALIZED VIEW' : 'CREATE OR REPLACE VIEW'} {S}.${this.quoteIdent(v.name)} AS\n${norm(v.def).replace(/;\s*$/, '')}`,
        deps: depsOf.get(v.name) ?? [],
      })),
      ...routines.map((r) => ({
        name: r.name,
        key: `${r.name}(${r.args})`,
        kind: (r.kind === 'p' ? 'procedure' : 'function') as SnapObject['kind'],
        def: norm(r.def).trim(),
      })),
      ...triggers.map((t) => ({ name: t.name, key: `${t.t}.${t.name}`, kind: 'trigger' as const, table: t.t, def: norm(t.def) })),
    ];
    return { kind: 'postgres', schema, tables, objects };
  }

  async erdModel(db: string, schema: string): Promise<ErdModel> {
    const FK = FK_ACTIONS;
    const [rels, cols, pks, fks] = await Promise.all([
      this.q<{ name: string; kind: string; rows: string | null; comment: string | null }>(
        db,
        `select c.relname as name, c.relkind::text as kind,
                case when c.reltuples < 0 then null else c.reltuples::bigint end as rows,
                obj_description(c.oid, 'pg_class') as comment
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind in ('r','p','v','m') and not c.relispartition
         order by 1`,
        [schema],
      ),
      this.q<{ t: string; name: string; type: string; nullable: boolean }>(
        db,
        `select c.relname as t, a.attname as name, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable
         from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = $1 and c.relkind in ('r','p','v','m') and a.attnum > 0 and not a.attisdropped
         order by c.relname, a.attnum`,
        [schema],
      ),
      this.q<{ t: string; col: string }>(
        db,
        `select c.relname as t, a.attname as col
         from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
         join lateral unnest(con.conkey) k(num) on true
         join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.num
         where n.nspname = $1 and con.contype = 'p'`,
        [schema],
      ),
      this.q<{ name: string; t: string; cols: string[]; rs: string; rt: string; rcols: string[]; del: string }>(
        db,
        `select con.conname as name, c.relname as t,
                array(select a.attname from unnest(con.conkey) with ordinality k(n, o)
                      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n order by k.o)::text[] as cols,
                rn.nspname as rs, rc.relname as rt,
                array(select a.attname from unnest(con.confkey) with ordinality k(n, o)
                      join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n order by k.o)::text[] as rcols,
                con.confdeltype::text as del
         from pg_constraint con join pg_class c on c.oid = con.conrelid join pg_namespace n on n.oid = c.relnamespace
         join pg_class rc on rc.oid = con.confrelid join pg_namespace rn on rn.oid = rc.relnamespace
         where n.nspname = $1 and con.contype = 'f' order by 2, 1`,
        [schema],
      ),
    ]);
    const pkSet = new Set(pks.map((p) => `${p.t}\u0000${p.col}`));
    const fkSet = new Set(fks.flatMap((f) => f.cols.map((c) => `${f.t}\u0000${c}`)));
    const byTable = new Map<string, ErdColumn[]>();
    for (const c of cols)
      (byTable.get(c.t) ?? byTable.set(c.t, []).get(c.t)!).push({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        pk: pkSet.has(`${c.t}\u0000${c.name}`),
        fk: fkSet.has(`${c.t}\u0000${c.name}`),
      });
    return {
      schema,
      tables: rels.map((r) => ({
        name: r.name,
        kind: r.kind === 'v' || r.kind === 'm' ? 'view' : 'table',
        rows: r.rows === null ? null : Number(r.rows),
        comment: r.comment,
        columns: byTable.get(r.name) ?? [],
      })),
      relations: fks.map((f) => ({
        name: f.name,
        from: f.t,
        fromColumns: f.cols,
        toSchema: f.rs,
        to: f.rt,
        toColumns: f.rcols,
        onDelete: FK[f.del] ?? f.del,
      })),
    };
  }

  async completion(db: string): Promise<CompletionSchema> {
    const rows = await this.q<{ s: string; t: string; c: string }>(
      db,
      `select table_schema s, table_name t, column_name c from information_schema.columns
       where table_schema not in ('pg_catalog','information_schema') order by 1, 2, ordinal_position limit 50000`,
    );
    const schemas: CompletionSchema['schemas'] = {};
    for (const r of rows) ((schemas[r.s] ??= {})[r.t] ??= []).push(r.c);
    const [d] = await this.q<{ s: string }>(db, 'select current_schema() s');
    return { schemas, defaultSchema: d?.s || 'public' };
  }

  private async typeName(db: string, oid: number): Promise<string | undefined> {
    if (!this.typeNames.size) {
      const rows = await this.q<{ oid: number; typname: string }>(db, 'select oid::int, typname from pg_type');
      for (const r of rows) this.typeNames.set(r.oid, r.typname);
    }
    return this.typeNames.get(oid);
  }

  private async fieldsOf(db: string, fields: { name: string; dataTypeID: number }[]): Promise<ResultField[]> {
    const out: ResultField[] = [];
    for (const f of fields) out.push({ name: f.name, type: await this.typeName(db, f.dataTypeID).catch(() => undefined) });
    return out;
  }

  private async session(sessionId: string, db: string): Promise<pg.Client> {
    const target = db || this.defaultDb();
    const s = this.sessions.get(sessionId);
    if (s && s.db === target) return s.client;
    if (s) {
      await s.client.end().catch(() => {});
      this.sessions.delete(sessionId);
    }
    const client = new pg.Client(await this.clientConfig(target));
    client.on('error', () => this.sessions.delete(sessionId));
    await client.connect();
    this.sessions.set(sessionId, { client, db: target });
    return client;
  }

  async execute(sessionId: string, db: string, statements: string[], maxRows: number): Promise<QueryResult[]> {
    const client = await this.session(sessionId, db);
    const results: QueryResult[] = [];
    for (const stmt of statements) {
      const t0 = performance.now();
      try {
        if (returnsRows(stmt)) {
          const cursor = client.query(new Cursor(stmt, [], { rowMode: 'array' }));
          const rows = (await cursor.read(maxRows + 1)) as unknown[][];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rawFields = ((cursor as any)._result?.fields ?? []) as { name: string; dataTypeID: number }[];
          await cursor.close();
          const truncated = rows.length > maxRows;
          if (truncated) rows.length = maxRows;
          results.push({
            statement: stmt,
            fields: await this.fieldsOf(db, rawFields),
            rows: rows.map(normalizeRow),
            rowCount: rows.length,
            truncated,
            durationMs: performance.now() - t0,
            command: 'SELECT',
          });
        } else {
          const r = await client.query({ text: stmt, rowMode: 'array' });
          const list = Array.isArray(r) ? r : [r];
          const last = list[list.length - 1] as pg.QueryResult<unknown[]>;
          const hasRows = last.fields && last.fields.length > 0;
          results.push({
            statement: stmt,
            fields: hasRows ? await this.fieldsOf(db, last.fields) : [],
            rows: hasRows ? last.rows.slice(0, maxRows).map(normalizeRow) : [],
            rowCount: hasRows ? last.rows.length : 0,
            affectedRows: last.rowCount ?? undefined,
            durationMs: performance.now() - t0,
            command: last.command,
          });
        }
      } catch (e) {
        const pos = Number((e as { position?: string }).position);
        results.push({
          statement: stmt,
          fields: [],
          rows: [],
          rowCount: 0,
          durationMs: performance.now() - t0,
          error: friendlyError(e),
          errorPosition: Number.isFinite(pos) ? lineOf(stmt, pos - 1) : undefined,
        });
        break;
      }
    }
    return results;
  }

  async cancel(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const pid = (s.client as any).processID as number;
    const [r] = await this.q<{ ok: boolean }>(s.db, 'select pg_cancel_backend($1) ok', [pid]);
    return !!r?.ok;
  }

  async closeSession(sessionId: string): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) await s.client.end().catch(() => {});
    this.sessions.delete(sessionId);
  }

  async fetchPage(db: string, schema: string, table: string, opts: PageOptions): Promise<TablePage> {
    const reg = this.qualified(schema, table);
    const [rel] = await this.q<{ k: string }>(db, 'select relkind::text k from pg_class where oid = $1::regclass', [reg]);
    const st = await this.structure(db, schema, table);
    const isTable = rel?.k === 'r' || rel?.k === 'p';
    const usesCtid = isTable && st.primaryKey.length === 0;
    let sql = `SELECT ${usesCtid ? `ctid::text AS ${this.quoteIdent(HIDDEN_KEY)}, ` : ''}* FROM ${reg}`;
    if (opts.where?.trim()) sql += ` WHERE ${opts.where}`;
    if (opts.orderBy?.length)
      sql += ' ORDER BY ' + opts.orderBy.map((o) => `${this.quoteIdent(o.column)} ${o.dir === 'desc' ? 'DESC' : 'ASC'}`).join(', ');
    else if (st.primaryKey.length) sql += ' ORDER BY ' + st.primaryKey.map((k) => this.quoteIdent(k)).join(', ');
    sql += ` LIMIT ${Math.max(1, opts.limit | 0)} OFFSET ${Math.max(0, opts.offset | 0)}`;
    const t0 = performance.now();
    const p = await this.pool(db);
    const r = await p.query({ text: sql, rowMode: 'array' });
    let readOnlyReason: string | undefined;
    if (!isTable) readOnlyReason = 'Vue ou objet non modifiable';
    else if (this.cfg.readOnly) readOnlyReason = 'Connexion en lecture seule';
    return {
      fields: await this.fieldsOf(db, r.fields),
      rows: (r.rows as unknown[][]).map(normalizeRow),
      keyColumns: st.primaryKey,
      hiddenKey: usesCtid ? HIDDEN_KEY : undefined,
      editable: !readOnlyReason,
      readOnlyReason,
      sql,
      durationMs: performance.now() - t0,
    };
  }

  async count(db: string, schema: string, table: string, where?: string): Promise<number> {
    const sql = `SELECT count(*)::bigint AS n FROM ${this.qualified(schema, table)}${where?.trim() ? ` WHERE ${where}` : ''}`;
    const [r] = await this.q<{ n: string }>(db, sql);
    return Number(r.n);
  }

  private buildChange(
    schema: string,
    table: string,
    ch: RowChange,
    hiddenKey: string | undefined,
    lit: boolean,
  ): { text: string; params: unknown[] } {
    const t = this.qualified(schema, table);
    const params: unknown[] = [];
    const ph = (v: CellValue, cast = '') => {
      if (lit) return this.literal(v) + cast;
      params.push(v);
      return `$${params.length}${cast}`;
    };
    const where = (key: Record<string, CellValue>) =>
      Object.entries(key)
        .map(([k, v]) => {
          if (k === hiddenKey) return `ctid = ${ph(v, '::tid')}`;
          return v === null ? `${this.quoteIdent(k)} IS NULL` : `${this.quoteIdent(k)} = ${ph(v)}`;
        })
        .join(' AND ');
    if (ch.type === 'update') {
      const set = Object.entries(ch.set)
        .map(([k, v]) => `${this.quoteIdent(k)} = ${ph(v)}`)
        .join(', ');
      return { text: `UPDATE ${t} SET ${set} WHERE ${where(ch.key)}`, params };
    }
    if (ch.type === 'delete') return { text: `DELETE FROM ${t} WHERE ${where(ch.key)}`, params };
    const cols = Object.keys(ch.values);
    if (!cols.length) return { text: `INSERT INTO ${t} DEFAULT VALUES`, params };
    const vals = cols.map((c) => ph(ch.values[c]));
    return { text: `INSERT INTO ${t} (${cols.map((c) => this.quoteIdent(c)).join(', ')}) VALUES (${vals.join(', ')})`, params };
  }

  previewChanges(schema: string, table: string, changes: RowChange[], hiddenKey?: string): string[] {
    return changes.map((c) => this.buildChange(schema, table, c, hiddenKey, true).text + ';');
  }

  async applyChanges(db: string, schema: string, table: string, changes: RowChange[], hiddenKey?: string): Promise<number> {
    const p = await this.pool(db);
    const client = await p.connect();
    let total = 0;
    try {
      await client.query('BEGIN');
      for (const ch of changes) {
        const { text, params } = this.buildChange(schema, table, ch, hiddenKey, false);
        const r = await client.query(text, params);
        if (ch.type !== 'insert' && r.rowCount !== 1)
          throw new Error(
            `${r.rowCount} ligne(s) touchée(s) au lieu d'une seule (la ligne a peut-être été modifiée entre-temps). Annulé.\n${text}`,
          );
        total += r.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return total;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }

  async processes(): Promise<ProcessInfo[]> {
    const rows = await this.q<Record<string, string | number | null>>(
      undefined,
      `select pid::text as id, coalesce(usename, '') as usr, coalesce(datname, '') as db,
              coalesce(client_addr::text, 'local') as client, coalesce(state, backend_type) as state,
              extract(epoch from (now() - coalesce(query_start, backend_start)))::int as dur, coalesce(query, '') as query
       from pg_stat_activity where pid <> pg_backend_pid() order by state = 'active' desc, dur desc nulls last`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      user: String(r.usr),
      database: String(r.db),
      client: String(r.client),
      state: String(r.state ?? ''),
      durationSec: r.dur === null ? null : Number(r.dur),
      query: String(r.query),
    }));
  }

  async kill(id: string, mode: 'cancel' | 'terminate'): Promise<void> {
    const fn = mode === 'cancel' ? 'pg_cancel_backend' : 'pg_terminate_backend';
    await this.q(undefined, `select ${fn}($1::int)`, [id]);
  }

  async *iterate(db: string, sql: string, batchSize: number): AsyncGenerator<Batch> {
    const client = new pg.Client(await this.clientConfig(db || this.defaultDb()));
    await client.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }));
      let fields: ResultField[] | null = null;
      for (;;) {
        const rows = (await cursor.read(batchSize)) as unknown[][];
        if (!fields) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          fields = await this.fieldsOf(db, ((cursor as any)._result?.fields ?? []) as never[]);
        }
        if (!rows.length) break;
        yield { fields, rows: rows.map(normalizeRow) };
        if (rows.length < batchSize) break;
      }
      await cursor.close();
      await client.query('COMMIT');
    } finally {
      await client.end().catch(() => {});
    }
  }

  async bulkInsert(
    db: string,
    schema: string,
    table: string,
    columns: string[],
    batches: AsyncIterable<CellValue[][]>,
    opts: { truncate: boolean; onProgress?: (n: number) => void },
  ): Promise<number> {
    const client = new pg.Client(await this.clientConfig(db || this.defaultDb()));
    await client.connect();
    const t = this.qualified(schema, table);
    const colSql = columns.map((c) => this.quoteIdent(c)).join(', ');
    const maxRowsPerStmt = Math.max(1, Math.floor(30000 / Math.max(1, columns.length)));
    let total = 0;
    try {
      await client.query('BEGIN');
      if (opts.truncate) await client.query(`TRUNCATE TABLE ${t}`);
      for await (const batch of batches) {
        for (let i = 0; i < batch.length; i += maxRowsPerStmt) {
          const chunk = batch.slice(i, i + maxRowsPerStmt);
          const params: unknown[] = [];
          const tuples = chunk.map((row) => '(' + row.map((v) => (params.push(v), `$${params.length}`)).join(', ') + ')');
          await client.query(`INSERT INTO ${t} (${colSql}) VALUES ${tuples.join(', ')}`, params);
          total += chunk.length;
          opts.onProgress?.(total);
        }
      }
      await client.query('COMMIT');
      return total;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      await client.end().catch(() => {});
    }
  }
}
