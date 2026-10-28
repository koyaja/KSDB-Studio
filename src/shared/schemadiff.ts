// Comparaison de deux schémas et génération du script qui aligne la CIBLE sur la SOURCE.
import type { DbKind } from './types';

// ---------------- Instantané ----------------

export interface SnapColumn {
  name: string;
  /** PG : type format_type ; MySQL : définition complète issue de SHOW CREATE TABLE */
  type: string;
  nullable: boolean;
  default: string | null;
  /** PG : 'a' (ALWAYS) / 'd' (BY DEFAULT) / '' */
  identity: string;
  comment: string | null;
  /** MySQL : définition complète de la colonne (après le nom) */
  def?: string;
  /** colonne calculée (GENERATED ... AS (...)) : jamais insérée */
  generated?: boolean;
}

export interface SnapIndex {
  name: string;
  unique: boolean;
  columns: string[];
  /** PG : CREATE INDEX normalisé (schéma remplacé par {S}) ; MySQL : ligne KEY de SHOW CREATE */
  def: string;
  /** PG : contrainte UNIQUE (et non simple index) */
  constraint?: boolean;
}

export interface SnapFk {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
  /** schéma référencé s'il diffère du schéma comparé (sinon null) */
  refSchema: string | null;
  /** MySQL : ligne CONSTRAINT de SHOW CREATE */
  def?: string;
}

export interface SnapTable {
  name: string;
  columns: SnapColumn[];
  pk: { name: string | null; columns: string[] } | null;
  indexes: SnapIndex[];
  fks: SnapFk[];
  comment: string | null;
  /** MySQL : CREATE TABLE complet (sans AUTO_INCREMENT=) */
  createSql?: string;
}

export interface SnapObject {
  name: string;
  /** clé d'identité (nom + signature pour les fonctions PG, table + nom pour les triggers) */
  key: string;
  kind: 'view' | 'matview' | 'function' | 'procedure' | 'trigger';
  /** définition normalisée (schéma remplacé par {S}) */
  def: string;
  /** table du trigger */
  table?: string;
  /** vues PG : relations du même schéma dont la vue dépend */
  deps?: string[];
}

export interface SchemaSnapshot {
  kind: DbKind;
  schema: string;
  tables: SnapTable[];
  objects: SnapObject[];
}

// ---------------- Résultat ----------------

export type DiffStatus = 'added' | 'removed' | 'changed';

/** Ordre d'exécution des morceaux de script. */
export const PHASES = [
  'dropFk',
  'dropObject',
  'createTable',
  'alterTable',
  'dropTable',
  'addFk',
  'createRoutine',
  'createView',
  'createTrigger',
] as const;
export type Phase = (typeof PHASES)[number];

export interface DiffItem {
  id: string;
  type: 'table' | SnapObject['kind'];
  name: string;
  status: DiffStatus;
  /** différences lisibles */
  details: string[];
  /** avertissements (perte de données possible, échec probable…) */
  warnings: string[];
  sql: Partial<Record<Phase, string[]>>;
  /** suppression de données ou d'objet : décoché par défaut */
  destructive: boolean;
  /** profondeur de dépendance (vues) : création par rang croissant, suppression par rang décroissant */
  rank?: number;
  /** PG : modification incompatible avec les vues dépendantes (type changé, colonne supprimée) */
  breaksViews?: boolean;
  /**
   * Vue identique mais à recréer : identifiants des tables dont la modification l'impose.
   * Non affichée ; ajoutée automatiquement au script si l'une de ces tables est sélectionnée.
   */
  auto?: string[];
}

export interface DiffResult {
  items: DiffItem[];
  identical: number;
}

// ---------------- Utilitaires ----------------

export const qid = (kind: DbKind, n: string) =>
  kind === 'mysql' ? '`' + n.replace(/`/g, '``') + '`' : '"' + n.replace(/"/g, '""') + '"';

const lit = (s: string) => "'" + s.replace(/'/g, "''") + "'";

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Remplace les qualifications « schema. » / « "schema". » / « `schema`. » par {S}. */
export function normalizeSchema(text: string, schema: string): string {
  const s = escapeRe(schema);
  return text
    .replace(new RegExp(`"${s}"\\.`, 'g'), '{S}.')
    .replace(new RegExp('`' + s + '`\\.', 'g'), '{S}.')
    .replace(new RegExp(`(?<![\\w"\`.])${s}\\.`, 'g'), '{S}.');
}

export function denormalize(text: string, kind: DbKind, schema: string): string {
  return text.replace(/\{S\}\./g, kind === 'mysql' ? '' : `${qid(kind, schema)}.`);
}

/** Valeur par défaut comparable (séquences PG : on ignore le nom de la séquence). */
function normDefault(d: string | null): string | null {
  if (d === null) return null;
  if (/^nextval\(/i.test(d)) return 'nextval()';
  return d.replace(/\s+/g, ' ').trim();
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

// ---------------- Comparaison ----------------

export interface DiffOptions {
  /** schéma cible (PG) / base cible (MySQL) */
  targetSchema: string;
}

export function diffSchemas(src: SchemaSnapshot, tgt: SchemaSnapshot, opts?: Partial<DiffOptions>): DiffResult {
  const kind = src.kind;
  const T = opts?.targetSchema ?? tgt.schema;
  const items: DiffItem[] = [];
  let identical = 0;
  const q = (n: string) => qid(kind, n);
  const qt = (table: string) => (kind === 'mysql' ? q(table) : `${q(T)}.${q(table)}`);

  // ---- Tables ----
  const tgtTables = new Map(tgt.tables.map((t) => [t.name, t]));
  const srcTables = new Map(src.tables.map((t) => [t.name, t]));

  for (const s of src.tables) {
    const t = tgtTables.get(s.name);
    if (!t) {
      items.push(createTableItem(kind, s, T));
      continue;
    }
    const item = alterTableItem(kind, s, t, T, qt);
    if (item) items.push(item);
    else identical++;
  }
  for (const t of tgt.tables) {
    if (srcTables.has(t.name)) continue;
    items.push({
      id: `table:${t.name}`,
      type: 'table',
      name: t.name,
      status: 'removed',
      details: ['Table absente de la source'],
      warnings: ['Supprime la table et toutes ses données'],
      sql: {
        dropFk: t.fks.map((f) => dropFk(kind, qt(t.name), f.name)),
        dropTable: [`DROP TABLE ${qt(t.name)}`],
      },
      destructive: true,
    });
  }

  // ---- Vues, routines, triggers ----
  const tgtObj = new Map(tgt.objects.map((o) => [`${o.kind}:${o.key}`, o]));
  const srcObj = new Map(src.objects.map((o) => [`${o.kind}:${o.key}`, o]));
  for (const s of src.objects) {
    const t = tgtObj.get(`${s.kind}:${s.key}`);
    if (t && clean(t.def) === clean(s.def)) {
      identical++;
      continue;
    }
    items.push(objectItem(kind, s, t ? 'changed' : 'added', T, t));
  }
  for (const t of tgt.objects) {
    if (srcObj.has(`${t.kind}:${t.key}`)) continue;
    items.push({
      id: `${t.kind}:${t.key}`,
      type: t.kind,
      name: t.name,
      status: 'removed',
      details: ['Absent de la source'],
      warnings: [],
      sql: { dropObject: [dropObject(kind, t, T)] },
      destructive: true,
    });
  }

  if (kind === 'postgres') rebuildDependentViews(items, src, tgt, T);

  const order = { table: 0, view: 1, matview: 2, function: 3, procedure: 4, trigger: 5 };
  items.sort((a, b) => order[a.type] - order[b.type] || a.name.localeCompare(b.name));
  return { items, identical };
}

const clean = (s: string) => s.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

// ---------- Tables ----------

function pgColumnDef(c: SnapColumn, forCreate: boolean): string {
  let type = c.type;
  let def = c.default;
  if (def && /^nextval\(/i.test(def) && forCreate) {
    const serial = { integer: 'serial', bigint: 'bigserial', smallint: 'smallserial' }[type];
    if (serial) {
      type = serial;
      def = null;
    }
  }
  let s = `${qid('postgres', c.name)} ${type}`;
  if (c.generated && c.default) {
    const expr = c.default.startsWith('(') ? c.default : `(${c.default})`;
    return `${s} GENERATED ALWAYS AS ${expr} STORED${c.nullable ? '' : ' NOT NULL'}`;
  }
  if (c.identity) s += ` GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
  else if (def !== null) s += ` DEFAULT ${def}`;
  if (!c.nullable) s += ' NOT NULL';
  return s;
}

function fkSql(kind: DbKind, f: SnapFk, T: string): string {
  if (kind === 'mysql' && f.def) return `ADD ${f.def}`;
  const q = (n: string) => qid(kind, n);
  const ref = f.refSchema ? `${q(f.refSchema)}.${q(f.refTable)}` : kind === 'mysql' ? q(f.refTable) : `${q(T)}.${q(f.refTable)}`;
  return (
    `ADD CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) REFERENCES ${ref} (${f.refColumns.map(q).join(', ')})` +
    `${f.onUpdate && f.onUpdate !== 'NO ACTION' ? ` ON UPDATE ${f.onUpdate}` : ''}${f.onDelete && f.onDelete !== 'NO ACTION' ? ` ON DELETE ${f.onDelete}` : ''}`
  );
}

function dropFk(kind: DbKind, qt: string, name: string) {
  return kind === 'mysql' ? `ALTER TABLE ${qt} DROP FOREIGN KEY ${qid(kind, name)}` : `ALTER TABLE ${qt} DROP CONSTRAINT ${qid(kind, name)}`;
}

function pgIndexSql(i: SnapIndex, T: string, table: string): string {
  if (i.constraint) return `ALTER TABLE ${qid('postgres', T)}.${qid('postgres', table)} ADD CONSTRAINT ${qid('postgres', i.name)} UNIQUE (${i.columns.map((c) => qid('postgres', c)).join(', ')})`;
  return denormalize(i.def, 'postgres', T);
}

function pgDropIndex(i: SnapIndex, T: string, table: string): string {
  if (i.constraint) return `ALTER TABLE ${qid('postgres', T)}.${qid('postgres', table)} DROP CONSTRAINT ${qid('postgres', i.name)}`;
  return `DROP INDEX ${qid('postgres', T)}.${qid('postgres', i.name)}`;
}

function createTableItem(kind: DbKind, s: SnapTable, T: string): DiffItem {
  const q = (n: string) => qid(kind, n);
  const sql: DiffItem['sql'] = {};
  if (kind === 'mysql') {
    // les FK de SHOW CREATE TABLE sont gardées : le script désactive FOREIGN_KEY_CHECKS
    sql.createTable = [s.createSql!];
  } else {
    const qt = `${q(T)}.${q(s.name)}`;
    const lines = s.columns.map((c) => '  ' + pgColumnDef(c, true));
    if (s.pk) lines.push(`  ${s.pk.name ? `CONSTRAINT ${q(s.pk.name)} ` : ''}PRIMARY KEY (${s.pk.columns.map(q).join(', ')})`);
    const create = [`CREATE TABLE ${qt} (\n${lines.join(',\n')}\n)`];
    for (const i of s.indexes) create.push(pgIndexSql(i, T, s.name));
    if (s.comment) create.push(`COMMENT ON TABLE ${qt} IS ${lit(s.comment)}`);
    for (const c of s.columns) if (c.comment) create.push(`COMMENT ON COLUMN ${qt}.${q(c.name)} IS ${lit(c.comment)}`);
    sql.createTable = create;
    if (s.fks.length) sql.addFk = s.fks.map((f) => `ALTER TABLE ${qt} ${fkSql(kind, f, T)}`);
  }
  return {
    id: `table:${s.name}`,
    type: 'table',
    name: s.name,
    status: 'added',
    details: [`Nouvelle table (${s.columns.length} colonnes${s.fks.length ? `, ${s.fks.length} clé(s) étrangère(s)` : ''})`],
    warnings: [],
    sql,
    destructive: false,
  };
}

function alterTableItem(kind: DbKind, s: SnapTable, t: SnapTable, T: string, qt: (n: string) => string): DiffItem | null {
  const q = (n: string) => qid(kind, n);
  const details: string[] = [];
  const warnings: string[] = [];
  const alter: string[] = [];
  const dropFks: string[] = [];
  const addFks: string[] = [];
  let destructive = false;
  let breaksViews = false;
  const table = qt(s.name);
  const tCols = new Map(t.columns.map((c) => [c.name, c]));
  const sCols = new Map(s.columns.map((c) => [c.name, c]));

  // PK : suppression avant les colonnes
  const pkChanged = !sameList(s.pk?.columns ?? [], t.pk?.columns ?? []);
  if (pkChanged && t.pk) {
    alter.push(kind === 'mysql' ? `ALTER TABLE ${table} DROP PRIMARY KEY` : `ALTER TABLE ${table} DROP CONSTRAINT ${q(t.pk.name ?? `${t.name}_pkey`)}`);
  }

  // Colonnes
  let prev: string | null = null;
  for (const c of s.columns) {
    const o = tCols.get(c.name);
    if (!o) {
      details.push(`+ colonne ${c.name}`);
      if (kind === 'mysql') alter.push(`ALTER TABLE ${table} ADD COLUMN ${q(c.name)} ${c.def} ${prev ? `AFTER ${q(prev)}` : 'FIRST'}`);
      else {
        alter.push(`ALTER TABLE ${table} ADD COLUMN ${pgColumnDef(c, true)}`);
        if (!c.nullable && c.default === null && !c.identity) warnings.push(`Ajout de ${c.name} NOT NULL sans défaut : échouera si la table contient des lignes`);
        if (c.comment) alter.push(`COMMENT ON COLUMN ${table}.${q(c.name)} IS ${lit(c.comment)}`);
      }
    } else if (kind === 'mysql') {
      if ((o.def ?? '') !== (c.def ?? '')) {
        details.push(`~ colonne ${c.name} : ${o.def} → ${c.def}`);
        alter.push(`ALTER TABLE ${table} MODIFY COLUMN ${q(c.name)} ${c.def}`);
      }
    } else if (!!c.generated !== !!o.generated || (c.generated && normDefault(o.default) !== normDefault(c.default))) {
      // colonne calculée : pas d'ALTER possible, on la recrée
      details.push(`~ ${c.name} : ${c.generated ? `calculée ${c.default}` : 'colonne normale'} (recréée)`);
      if (!o.generated) warnings.push(`${c.name} devient une colonne calculée : ses valeurs actuelles sont perdues`);
      alter.push(`ALTER TABLE ${table} DROP COLUMN ${q(c.name)}`);
      alter.push(`ALTER TABLE ${table} ADD COLUMN ${pgColumnDef(c, true)}`);
      breaksViews = true;
    } else {
      const n = q(c.name);
      if (o.type !== c.type) {
        breaksViews = true;
        details.push(`~ ${c.name} : type ${o.type} → ${c.type}`);
        alter.push(`ALTER TABLE ${table} ALTER COLUMN ${n} TYPE ${c.type} USING ${n}::${c.type}`);
        warnings.push(`Changement de type de ${c.name} : vérifie la conversion des données existantes`);
      }
      if (o.nullable !== c.nullable) {
        details.push(`~ ${c.name} : ${c.nullable ? 'accepte NULL' : 'NOT NULL'}`);
        alter.push(`ALTER TABLE ${table} ALTER COLUMN ${n} ${c.nullable ? 'DROP' : 'SET'} NOT NULL`);
        if (!c.nullable) warnings.push(`${c.name} passe NOT NULL : échouera s'il existe des NULL`);
      }
      if (o.identity !== c.identity) {
        details.push(`~ ${c.name} : identity ${o.identity || 'aucune'} → ${c.identity || 'aucune'}`);
        if (o.identity) alter.push(`ALTER TABLE ${table} ALTER COLUMN ${n} DROP IDENTITY IF EXISTS`);
        if (c.identity) alter.push(`ALTER TABLE ${table} ALTER COLUMN ${n} ADD GENERATED ${c.identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`);
      } else if (normDefault(o.default) !== normDefault(c.default) && !c.identity) {
        details.push(`~ ${c.name} : défaut ${o.default ?? 'aucun'} → ${c.default ?? 'aucun'}`);
        alter.push(`ALTER TABLE ${table} ALTER COLUMN ${n} ${c.default !== null ? `SET DEFAULT ${c.default}` : 'DROP DEFAULT'}`);
      }
      if ((o.comment ?? '') !== (c.comment ?? '')) {
        details.push(`~ ${c.name} : commentaire`);
        alter.push(`COMMENT ON COLUMN ${table}.${n} IS ${c.comment ? lit(c.comment) : 'NULL'}`);
      }
    }
    prev = c.name;
  }
  for (const o of t.columns) {
    if (sCols.has(o.name)) continue;
    breaksViews = true;
    details.push(`− colonne ${o.name}`);
    warnings.push(`Suppression de la colonne ${o.name} et de ses données`);
    alter.push(`ALTER TABLE ${table} DROP COLUMN ${q(o.name)}`);
    destructive = true;
  }
  if (pkChanged) {
    details.push(`~ clé primaire (${(t.pk?.columns ?? []).join(', ') || 'aucune'}) → (${(s.pk?.columns ?? []).join(', ') || 'aucune'})`);
    if (s.pk) alter.push(`ALTER TABLE ${table} ADD ${kind === 'postgres' && s.pk.name ? `CONSTRAINT ${q(s.pk.name)} ` : ''}PRIMARY KEY (${s.pk.columns.map(q).join(', ')})`);
  }

  // Index
  const tIdx = new Map(t.indexes.map((i) => [i.name, i]));
  const sIdx = new Map(s.indexes.map((i) => [i.name, i]));
  for (const i of s.indexes) {
    const o = tIdx.get(i.name);
    if (o && o.def === i.def && !!o.constraint === !!i.constraint) continue;
    if (o) {
      details.push(`~ index ${i.name}`);
      alter.push(kind === 'mysql' ? `ALTER TABLE ${table} DROP INDEX ${q(i.name)}` : pgDropIndex(o, T, t.name));
    } else details.push(`+ index ${i.name}`);
    alter.push(kind === 'mysql' ? `ALTER TABLE ${table} ADD ${i.def}` : pgIndexSql(i, T, s.name));
  }
  for (const o of t.indexes) {
    if (sIdx.has(o.name)) continue;
    details.push(`− index ${o.name}`);
    alter.push(kind === 'mysql' ? `ALTER TABLE ${table} DROP INDEX ${q(o.name)}` : pgDropIndex(o, T, t.name));
  }

  // Clés étrangères
  const fkSig = (f: SnapFk) => (kind === 'mysql' ? f.def ?? '' : `${f.columns}|${f.refSchema ?? ''}|${f.refTable}|${f.refColumns}|${f.onUpdate}|${f.onDelete}`);
  const tFk = new Map(t.fks.map((f) => [f.name, f]));
  const sFk = new Map(s.fks.map((f) => [f.name, f]));
  for (const f of s.fks) {
    const o = tFk.get(f.name);
    if (o && fkSig(o) === fkSig(f)) continue;
    if (o) {
      details.push(`~ clé étrangère ${f.name}`);
      dropFks.push(dropFk(kind, table, o.name));
    } else details.push(`+ clé étrangère ${f.name} → ${f.refTable}`);
    addFks.push(`ALTER TABLE ${table} ${fkSql(kind, f, T)}`);
  }
  for (const o of t.fks) {
    if (sFk.has(o.name)) continue;
    details.push(`− clé étrangère ${o.name}`);
    dropFks.push(dropFk(kind, table, o.name));
  }

  // Commentaire de table
  if ((s.comment ?? '') !== (t.comment ?? '')) {
    details.push('~ commentaire de la table');
    alter.push(kind === 'mysql' ? `ALTER TABLE ${table} COMMENT = ${lit(s.comment ?? '')}` : `COMMENT ON TABLE ${table} IS ${s.comment ? lit(s.comment) : 'NULL'}`);
  }

  if (!details.length) return null;
  return {
    id: `table:${s.name}`,
    type: 'table',
    name: s.name,
    status: 'changed',
    details,
    warnings,
    sql: { dropFk: dropFks, alterTable: alter, addFk: addFks },
    destructive,
    breaksViews,
  };
}

// ---------- Vues, routines, triggers ----------

function dropObject(kind: DbKind, o: SnapObject, T: string): string {
  const q = (n: string) => qid(kind, n);
  const qn = kind === 'mysql' ? q(o.name) : `${q(T)}.${q(o.name)}`;
  switch (o.kind) {
    case 'view':
      return `DROP VIEW IF EXISTS ${qn}`;
    case 'matview':
      return `DROP MATERIALIZED VIEW IF EXISTS ${qn}`;
    case 'function':
      return kind === 'mysql' ? `DROP FUNCTION IF EXISTS ${qn}` : `DROP FUNCTION IF EXISTS ${qn}(${o.key.slice(o.name.length + 1, -1)})`;
    case 'procedure':
      return kind === 'mysql' ? `DROP PROCEDURE IF EXISTS ${qn}` : `DROP PROCEDURE IF EXISTS ${qn}(${o.key.slice(o.name.length + 1, -1)})`;
    case 'trigger':
      return kind === 'mysql' ? `DROP TRIGGER IF EXISTS ${qn}` : `DROP TRIGGER IF EXISTS ${q(o.name)} ON ${q(T)}.${q(o.table!)}`;
  }
}

function objectItem(kind: DbKind, s: SnapObject, status: 'added' | 'changed', T: string, old?: SnapObject): DiffItem {
  const body = denormalize(s.def, kind, T);
  const sql: DiffItem['sql'] = {};
  const label = { view: 'Vue', matview: 'Vue matérialisée', function: 'Fonction', procedure: 'Procédure', trigger: 'Trigger' }[s.kind];
  const warnings: string[] = [];
  if (kind === 'mysql' && (s.kind === 'function' || s.kind === 'procedure' || s.kind === 'trigger')) {
    const pre = status === 'changed' && old ? [dropObject(kind, old, T)] : [];
    const blk = [...pre, `DELIMITER $$\n${body} $$\nDELIMITER ;`];
    if (s.kind === 'trigger') sql.createTrigger = blk;
    else sql.createRoutine = blk;
  } else if (s.kind === 'view') {
    sql.createView = [kind === 'mysql' ? body.replace(/^CREATE\s+/i, 'CREATE OR REPLACE ') : body];
    if (status === 'changed') warnings.push('Si les colonnes de la vue changent, CREATE OR REPLACE peut échouer : supprime-la d’abord');
  } else if (s.kind === 'matview') {
    sql.createView = [...(old ? [dropObject(kind, old, T)] : []), body];
  } else if (s.kind === 'trigger') {
    sql.createTrigger = [...(old ? [dropObject(kind, old, T)] : []), body];
  } else {
    sql.createRoutine = [body];
  }
  return {
    id: `${s.kind}:${s.key}`,
    type: s.kind,
    name: s.name,
    status,
    details: [status === 'added' ? `${label} absente de la cible` : `${label} : définition différente`],
    warnings,
    sql,
    destructive: false,
  };
}

// ---------------- Script ----------------

/**
 * PostgreSQL : une vue empêche de modifier le type d'une colonne qu'elle utilise, et CREATE OR REPLACE VIEW
 * échoue si ses colonnes changent. Les vues touchées (et celles qui en dépendent) sont donc supprimées
 * avant les modifications de tables puis recréées dans l'ordre de leurs dépendances.
 */
function rebuildDependentViews(items: DiffItem[], src: SchemaSnapshot, tgt: SchemaSnapshot, T: string) {
  const isView = (o: SnapObject) => o.kind === 'view' || o.kind === 'matview';
  const tViews = new Map(tgt.objects.filter(isView).map((o) => [o.name, o]));
  const sViews = new Map(src.objects.filter(isView).map((o) => [o.name, o]));
  const broken = new Set(items.filter((i) => i.type === 'table' && i.breaksViews).map((i) => i.name));
  const rebuild = new Set<string>();
  /** vue → identifiants des éléments qui imposent sa reconstruction */
  const cause = new Map<string, Set<string>>();
  for (const i of items)
    if ((i.type === 'view' || i.type === 'matview') && i.status === 'changed') {
      rebuild.add(i.name);
      cause.set(i.name, new Set([i.id]));
    }
  // propagation : vues de la cible qui dépendent d'une table cassée ou d'une vue reconstruite
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, v] of tViews) {
      if (!sViews.has(name)) continue;
      const set = cause.get(name) ?? new Set<string>();
      const before = set.size;
      for (const d of v.deps ?? []) {
        if (broken.has(d)) set.add(`table:${d}`);
        for (const c of cause.get(d) ?? []) set.add(c);
      }
      if (set.size && !rebuild.has(name)) rebuild.add(name);
      if (set.size !== before || (set.size && !cause.has(name))) {
        cause.set(name, set);
        grew = true;
      }
    }
  }
  if (!rebuild.size) return;
  // rang = profondeur dans le graphe des dépendances de la source
  const rankOf = new Map<string, number>();
  const rank = (n: string, seen = new Set<string>()): number => {
    if (rankOf.has(n)) return rankOf.get(n)!;
    if (seen.has(n)) return 0;
    seen.add(n);
    const deps = (sViews.get(n)?.deps ?? []).filter((d) => sViews.has(d));
    const r = deps.length ? 1 + Math.max(...deps.map((d) => rank(d, seen))) : 0;
    rankOf.set(n, r);
    return r;
  };
  for (const name of rebuild) {
    const s = sViews.get(name)!;
    const t = tViews.get(name)!;
    const drop = dropObject('postgres', t, T);
    const create = denormalize(s.def.replace(/^CREATE OR REPLACE VIEW/, 'CREATE VIEW'), 'postgres', T);
    let item = items.find((i) => i.id === `${s.kind}:${s.key}`);
    if (!item) {
      item = {
        id: `${s.kind}:${s.key}`,
        type: s.kind,
        name,
        status: 'changed',
        details: ['Recréée : dépend d’une table ou d’une vue modifiée'],
        warnings: [],
        sql: {},
        destructive: false,
        auto: [...(cause.get(name) ?? [])],
      };
      items.push(item);
    }
    item.sql = { dropObject: [drop], createView: [create] };
    item.warnings = item.warnings.filter((w) => !w.startsWith('Si les colonnes'));
    item.rank = rank(name);
  }
}

/**
 * Script des éléments sélectionnés. `all` (tous les éléments du diff) permet d'ajouter automatiquement
 * les vues à recréer à cause d'une table sélectionnée.
 */
export function buildScript(kind: DbKind, selected: DiffItem[], header?: string, all?: DiffItem[]): string {
  const ids = new Set(selected.map((i) => i.id));
  const extra = (all ?? []).filter((i) => i.auto && !ids.has(i.id) && i.auto.some((a) => ids.has(a)));
  const items = [...selected, ...extra];
  const parts: string[] = [];
  if (header) parts.push(header.split('\n').map((l) => `-- ${l}`).join('\n'));
  if (kind === 'mysql') parts.push('SET FOREIGN_KEY_CHECKS = 0;');
  for (const phase of PHASES) {
    const ordered =
      phase === 'dropObject'
        ? [...items].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0))
        : phase === 'createView'
          ? [...items].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
          : items;
    const chunk = ordered.flatMap((i) => i.sql[phase] ?? []);
    if (!chunk.length) continue;
    parts.push(`-- ${PHASE_LABEL[phase]}`);
    for (const s of chunk) parts.push(/DELIMITER/.test(s) ? s : s.replace(/;\s*$/, '') + ';');
  }
  if (kind === 'mysql') parts.push('SET FOREIGN_KEY_CHECKS = 1;');
  return parts.join('\n\n') + '\n';
}

const PHASE_LABEL: Record<Phase, string> = {
  dropFk: 'Suppression des clés étrangères modifiées',
  dropObject: 'Suppression des vues, routines et triggers absents de la source',
  createTable: 'Nouvelles tables',
  alterTable: 'Modification des tables existantes',
  dropTable: 'Suppression des tables absentes de la source',
  addFk: 'Clés étrangères',
  createRoutine: 'Fonctions et procédures',
  createView: 'Vues',
  createTrigger: 'Triggers',
};
