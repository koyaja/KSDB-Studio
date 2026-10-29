// Utilisateurs, rôles et droits : modèle commun, analyse de SHOW GRANTS et génération du SQL.
// Partagé entre le process principal (lecture, tests) et l'interface (aperçu du script).
import type { DbKind } from './types';

export type PrivObjectType = 'global' | 'database' | 'schema' | 'table' | 'view' | 'sequence' | 'function' | 'procedure';

export interface RoleInfo {
  name: string;
  /** MySQL : hôte du compte ('' pour un rôle MariaDB) ; '' sous PostgreSQL */
  host: string;
  /** Rôle de groupe (PG : NOLOGIN ; MySQL : CREATE ROLE) */
  isRole: boolean;
  canLogin: boolean;
  superuser: boolean;
  createDb: boolean;
  createRole: boolean;
  replication: boolean;
  bypassRls: boolean;
  inherit: boolean;
  /** PG : -1 = illimité ; MySQL : 0 = illimité */
  connLimit: number;
  /** PG : date d'expiration du mot de passe */
  validUntil: string | null;
  /** MySQL : compte verrouillé */
  locked: boolean;
  /** null = inconnu (droits insuffisants pour le savoir) */
  hasPassword: boolean | null;
  comment: string | null;
  /** clés des rôles dont ce compte est membre (voir accountKey) */
  memberOf: string[];
  /** rôle interne du serveur (pg_*, mariadb.sys…) */
  system?: boolean;
}

export interface PrivObject {
  /** identifiant stable : type|base|schéma|nom(args) */
  key: string;
  type: PrivObjectType;
  /** MySQL : base de l'objet */
  database?: string;
  /** PG : schéma de l'objet */
  schema?: string;
  name: string;
  /** PG : arguments d'une fonction / procédure (GRANT … ON FUNCTION f(args)) */
  args?: string;
  owner?: string;
  /** le rôle est propriétaire : il a tous les droits, non modifiables ici */
  isOwner?: boolean;
  privileges: string[];
  /** droits accordés WITH GRANT OPTION */
  grantable: string[];
}

export interface RoleDetail {
  role: RoleInfo;
  /** objets de la portée affichée (base courante), avec les droits du rôle */
  objects: PrivObject[];
  /** comptes membres de ce rôle */
  members: string[];
  /** droits non gérés par l'éditeur (colonnes, PROXY, motifs de bases…) : affichés tels quels */
  other: string[];
}

export interface RoleDraft extends RoleInfo {
  /** nouveau mot de passe ; vide = inchangé */
  password?: string;
  /** PG : supprimer le mot de passe */
  clearPassword?: boolean;
}

export type Flavor = 'postgres' | 'mysql' | 'mariadb';

// ---------------- Identifiants ----------------

export const qi = (kind: DbKind, n: string) => (kind === 'mysql' ? '`' + n.replace(/`/g, '``') + '`' : '"' + n.replace(/"/g, '""') + '"');

export function lit(kind: DbKind, s: string) {
  return kind === 'mysql' ? "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "''") + "'" : "'" + s.replace(/'/g, "''") + "'";
}

/** Clé d'un compte : « nom » (PG, rôle MariaDB) ou « nom@hôte » (MySQL) */
export const accountKey = (name: string, host: string) => (host ? `${name}@${host}` : name);

export function parseAccountKey(key: string): { name: string; host: string } {
  const i = key.lastIndexOf('@');
  return i > 0 ? { name: key.slice(0, i), host: key.slice(i + 1) } : { name: key, host: '' };
}

/** Référence SQL d'un compte */
export function accountRef(kind: DbKind, name: string, host: string): string {
  if (kind === 'postgres') return qi(kind, name);
  return host ? `${qi(kind, name)}@${qi(kind, host)}` : qi(kind, name);
}

export function objectKey(o: Pick<PrivObject, 'type' | 'database' | 'schema' | 'name' | 'args'>) {
  return [o.type, o.database ?? '', o.schema ?? '', o.name + (o.args !== undefined ? `(${o.args})` : '')].join('|');
}

/** Référence SQL d'un objet dans GRANT / REVOKE */
export function objectRef(kind: DbKind, o: PrivObject): string {
  const q = (n: string) => qi(kind, n);
  if (kind === 'postgres') {
    switch (o.type) {
      case 'database':
        return `DATABASE ${q(o.name)}`;
      case 'schema':
        return `SCHEMA ${q(o.name)}`;
      case 'sequence':
        return `SEQUENCE ${q(o.schema!)}.${q(o.name)}`;
      case 'function':
      case 'procedure':
        return `${o.type === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${q(o.schema!)}.${q(o.name)}(${o.args ?? ''})`;
      default:
        return `TABLE ${q(o.schema!)}.${q(o.name)}`;
    }
  }
  switch (o.type) {
    case 'global':
      return '*.*';
    case 'database':
      return `${q(o.name)}.*`;
    case 'function':
    case 'procedure':
      return `${o.type === 'function' ? 'FUNCTION' : 'PROCEDURE'} ${q(o.database!)}.${q(o.name)}`;
    default:
      return `${q(o.database!)}.${q(o.name)}`;
  }
}

// ---------------- Droits disponibles ----------------

const PG_PRIVS: Record<string, string[]> = {
  database: ['CONNECT', 'CREATE', 'TEMPORARY'],
  schema: ['USAGE', 'CREATE'],
  table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  view: ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'],
  sequence: ['USAGE', 'SELECT', 'UPDATE'],
  function: ['EXECUTE'],
  procedure: ['EXECUTE'],
};

const MY_OBJECT = [
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'INDEX',
  'REFERENCES',
  'CREATE VIEW',
  'SHOW VIEW',
  'TRIGGER',
];

const MY_PRIVS: Record<string, string[]> = {
  global: [
    ...MY_OBJECT,
    'CREATE TEMPORARY TABLES',
    'LOCK TABLES',
    'EXECUTE',
    'CREATE ROUTINE',
    'ALTER ROUTINE',
    'EVENT',
    'PROCESS',
    'RELOAD',
    'SHUTDOWN',
    'FILE',
    'SHOW DATABASES',
    'SUPER',
    'REPLICATION SLAVE',
    'REPLICATION CLIENT',
    'CREATE USER',
  ],
  database: [...MY_OBJECT, 'CREATE TEMPORARY TABLES', 'LOCK TABLES', 'EXECUTE', 'CREATE ROUTINE', 'ALTER ROUTINE', 'EVENT'],
  table: MY_OBJECT,
  view: MY_OBJECT,
  function: ['EXECUTE', 'ALTER ROUTINE'],
  procedure: ['EXECUTE', 'ALTER ROUTINE'],
};

/** Droits proposés pour un type d'objet */
export function privilegeSet(kind: DbKind, type: PrivObjectType): string[] {
  return (kind === 'postgres' ? PG_PRIVS : MY_PRIVS)[type] ?? [];
}

/** Libellés courts pour les colonnes de la grille */
export const PRIV_SHORT: Record<string, string> = {
  SELECT: 'SELECT',
  INSERT: 'INSERT',
  UPDATE: 'UPDATE',
  DELETE: 'DELETE',
  TRUNCATE: 'TRUNC.',
  REFERENCES: 'REFS',
  TRIGGER: 'TRIGGER',
  CONNECT: 'CONNECT',
  TEMPORARY: 'TEMP',
  'CREATE TEMPORARY TABLES': 'TEMP',
  'CREATE VIEW': 'CR. VIEW',
  'SHOW VIEW': 'SH. VIEW',
  'CREATE ROUTINE': 'CR. ROUT.',
  'ALTER ROUTINE': 'AL. ROUT.',
  'LOCK TABLES': 'LOCK',
  'SHOW DATABASES': 'SH. DBS',
  'REPLICATION SLAVE': 'REPL. SL.',
  'REPLICATION CLIENT': 'REPL. CL.',
  'CREATE USER': 'CR. USER',
};

export interface Preset {
  id: 'none' | 'read' | 'write' | 'all';
  label: string;
}

export const PRESETS: Preset[] = [
  { id: 'read', label: 'Lecture seule' },
  { id: 'write', label: 'Lecture / écriture' },
  { id: 'all', label: 'Tous les droits' },
  { id: 'none', label: 'Aucun droit' },
];

/** Droits d'un modèle pour un type d'objet */
export function presetPrivileges(kind: DbKind, preset: Preset['id'], type: PrivObjectType): string[] {
  const all = privilegeSet(kind, type);
  if (preset === 'none') return [];
  if (preset === 'all') return all;
  const pick = (l: string[]) => all.filter((p) => l.includes(p));
  if (kind === 'postgres') {
    const read: Record<string, string[]> = {
      database: ['CONNECT'],
      schema: ['USAGE'],
      table: ['SELECT'],
      view: ['SELECT'],
      sequence: ['SELECT'],
      function: ['EXECUTE'],
      procedure: ['EXECUTE'],
    };
    const write: Record<string, string[]> = {
      database: ['CONNECT', 'TEMPORARY'],
      schema: ['USAGE'],
      table: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
      view: ['SELECT'],
      sequence: ['USAGE', 'SELECT', 'UPDATE'],
      function: ['EXECUTE'],
      procedure: ['EXECUTE'],
    };
    return pick((preset === 'read' ? read : write)[type] ?? []);
  }
  const read = ['SELECT', 'SHOW VIEW', 'EXECUTE'];
  const write = [...read, 'INSERT', 'UPDATE', 'DELETE', 'LOCK TABLES', 'CREATE TEMPORARY TABLES'];
  // les droits globaux (*.*) ne sont jamais accordés par un modèle
  if (type === 'global') return [];
  return pick(preset === 'read' ? read : write);
}

// ---------------- Analyse de SHOW GRANTS (MySQL / MariaDB) ----------------

/** Découpe sur les virgules hors parenthèses */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const unq = (s: string) => (s.startsWith('`') ? s.slice(1, -1).replace(/``/g, '`') : s).replace(/\\([_%])/g, '$1');

export interface ParsedGrants {
  objects: { type: PrivObjectType; database?: string; name: string; privileges: string[]; grantable: boolean; all: boolean }[];
  /** rôles accordés (clés de compte) */
  roles: string[];
  other: string[];
}

const IDENT = '`(?:[^`]|``)*`';
const GRANT_ON = new RegExp(`^GRANT\\s+(.+?)\\s+ON\\s+(?:(FUNCTION|PROCEDURE|TABLE)\\s+)?(\\*\\.\\*|\\*|${IDENT}\\.(?:\\*|${IDENT}))\\s+TO\\s+(.*)$`, 'is');
const GRANT_ROLE = new RegExp(`^GRANT\\s+((?:${IDENT}(?:@${IDENT})?\\s*,?\\s*)+?)\\s+TO\\s+(.*)$`, 'is');

export function parseMysqlGrants(lines: string[]): ParsedGrants {
  const res: ParsedGrants = { objects: [], roles: [], other: [] };
  for (const raw of lines) {
    const line = raw.trim();
    const m = GRANT_ON.exec(line);
    if (m) {
      const [, privPart, routine, target, rest] = m;
      const grantable = /\bWITH\b.*\bGRANT OPTION\b/i.test(rest);
      if (/^PROXY$/i.test(privPart.trim())) {
        res.other.push(line);
        continue;
      }
      let type: PrivObjectType;
      let database: string | undefined;
      let name: string;
      if (target === '*.*' || target === '*') {
        type = 'global';
        name = '*.*';
      } else {
        const dot = target.match(new RegExp(`^(${IDENT})\\.(\\*|${IDENT})$`))!;
        const db = unq(dot[1]);
        if (/(^|[^\\])[%]/.test(dot[1])) {
          // motif de base (ex. `app_%`.*) : non géré par l'éditeur
          res.other.push(line);
          continue;
        }
        if (dot[2] === '*') {
          type = 'database';
          name = db;
        } else {
          type = routine === 'FUNCTION' ? 'function' : routine === 'PROCEDURE' ? 'procedure' : 'table';
          database = db;
          name = unq(dot[2]);
        }
      }
      const items = splitTop(privPart);
      const privileges: string[] = [];
      let all = false;
      let hasColumn = false;
      for (const it of items) {
        const p = it.toUpperCase().replace(/\s+/g, ' ');
        if (p.includes('(')) hasColumn = true;
        else if (p === 'ALL PRIVILEGES' || p === 'ALL') all = true;
        else if (p !== 'USAGE') privileges.push(p);
      }
      if (hasColumn) res.other.push(line);
      if (all) for (const p of privilegeSet('mysql', type)) if (!privileges.includes(p)) privileges.push(p);
      res.objects.push({ type, database, name, privileges, grantable, all });
      continue;
    }
    const r = GRANT_ROLE.exec(line);
    if (r && !/\sON\s/i.test(r[1])) {
      for (const part of r[1].split(/\s*,\s*/).filter(Boolean)) {
        const pm = part.match(new RegExp(`^(${IDENT})(?:@(${IDENT}))?$`));
        if (pm) res.roles.push(accountKey(unq(pm[1]), pm[2] ? unq(pm[2]) : ''));
      }
      continue;
    }
    if (/^SET DEFAULT ROLE/i.test(line)) continue;
    res.other.push(line);
  }
  return res;
}

// ---------------- Génération du script ----------------

export interface ScriptOptions {
  flavor?: Flavor;
  /** masque les mots de passe (aperçu) */
  mask?: boolean;
}

const PG_ATTRS: [keyof RoleInfo, string, string][] = [
  ['superuser', 'SUPERUSER', 'NOSUPERUSER'],
  ['createDb', 'CREATEDB', 'NOCREATEDB'],
  ['createRole', 'CREATEROLE', 'NOCREATEROLE'],
  ['inherit', 'INHERIT', 'NOINHERIT'],
  ['replication', 'REPLICATION', 'NOREPLICATION'],
  ['bypassRls', 'BYPASSRLS', 'NOBYPASSRLS'],
  ['canLogin', 'LOGIN', 'NOLOGIN'],
];

function pw(kind: DbKind, s: string, mask?: boolean) {
  return mask ? "'••••••••'" : lit(kind, s);
}

function privDiff(kind: DbKind, before: PrivObject | undefined, after: PrivObject, target: string): string[] {
  if (after.isOwner) return [];
  const prev = new Set(before?.privileges ?? []);
  const next = new Set(after.privileges);
  const add = privilegeSet(kind, after.type).filter((p) => next.has(p) && !prev.has(p));
  for (const p of after.privileges) if (!prev.has(p) && !add.includes(p)) add.push(p);
  const del = [...prev].filter((p) => !next.has(p));
  const out: string[] = [];
  const ref = objectRef(kind, after);
  const full = privilegeSet(kind, after.type);
  if (add.length) {
    const list = !prev.size && full.length > 1 && full.every((p) => next.has(p)) && next.size === full.length ? 'ALL PRIVILEGES' : add.join(', ');
    out.push(`GRANT ${list} ON ${ref} TO ${target};`);
  }
  if (del.length) out.push(`REVOKE ${del.join(', ')} ON ${ref} FROM ${target};`);
  return out;
}

/**
 * Script qui fait passer le compte de `before` (null = nouveau) à `draft`, avec les droits `objects`.
 * Les objets absents de `objects` ne sont pas modifiés.
 */
export function buildRoleScript(
  kind: DbKind,
  before: RoleDetail | null,
  draft: RoleDraft,
  objects: PrivObject[],
  opts: ScriptOptions = {},
): string[] {
  const out: string[] = [];
  const b = before?.role;
  const target = accountRef(kind, draft.name, draft.host);

  if (kind === 'postgres') {
    if (!b) {
      const attrs = PG_ATTRS.filter(([k]) => (k === 'inherit' ? !draft.inherit : !!draft[k])).map(([k, on, off]) => (draft[k] ? on : off));
      if (draft.connLimit !== -1) attrs.push(`CONNECTION LIMIT ${Math.trunc(draft.connLimit)}`);
      if (draft.password) attrs.push(`PASSWORD ${pw(kind, draft.password, opts.mask)}`);
      if (draft.validUntil) attrs.push(`VALID UNTIL ${lit(kind, draft.validUntil)}`);
      out.push(`CREATE ROLE ${target}${attrs.length ? ' WITH ' + attrs.join(' ') : ''};`);
      if (draft.comment) out.push(`COMMENT ON ROLE ${target} IS ${lit(kind, draft.comment)};`);
    } else {
      if (b.name !== draft.name) out.push(`ALTER ROLE ${qi(kind, b.name)} RENAME TO ${target};`);
      const attrs = PG_ATTRS.filter(([k]) => b[k] !== draft[k]).map(([k, on, off]) => (draft[k] ? on : off));
      if (b.connLimit !== draft.connLimit) attrs.push(`CONNECTION LIMIT ${Math.trunc(draft.connLimit)}`);
      if (draft.password) attrs.push(`PASSWORD ${pw(kind, draft.password, opts.mask)}`);
      else if (draft.clearPassword) attrs.push('PASSWORD NULL');
      if ((b.validUntil ?? '') !== (draft.validUntil ?? '')) attrs.push(`VALID UNTIL ${lit(kind, draft.validUntil || 'infinity')}`);
      if (attrs.length) out.push(`ALTER ROLE ${target} WITH ${attrs.join(' ')};`);
      if ((b.comment ?? '') !== (draft.comment ?? '')) out.push(`COMMENT ON ROLE ${target} IS ${draft.comment ? lit(kind, draft.comment) : 'NULL'};`);
    }
  } else {
    if (!b) {
      if (draft.isRole) out.push(`CREATE ROLE ${target};`);
      else {
        let s = `CREATE USER ${target}`;
        if (draft.password) s += ` IDENTIFIED BY ${pw(kind, draft.password, opts.mask)}`;
        if (draft.connLimit > 0) s += ` WITH MAX_USER_CONNECTIONS ${Math.trunc(draft.connLimit)}`;
        if (draft.locked) s += ' ACCOUNT LOCK';
        out.push(s + ';');
      }
    } else {
      if (b.name !== draft.name || b.host !== draft.host) out.push(`RENAME USER ${accountRef(kind, b.name, b.host)} TO ${target};`);
      if (!draft.isRole) {
        if (draft.password) out.push(`ALTER USER ${target} IDENTIFIED BY ${pw(kind, draft.password, opts.mask)};`);
        if (b.connLimit !== draft.connLimit) out.push(`ALTER USER ${target} WITH MAX_USER_CONNECTIONS ${Math.max(0, Math.trunc(draft.connLimit))};`);
        if (b.locked !== draft.locked) out.push(`ALTER USER ${target} ACCOUNT ${draft.locked ? 'LOCK' : 'UNLOCK'};`);
      }
    }
  }

  // appartenance aux rôles
  const prevRoles = new Set(b?.memberOf ?? []);
  const nextRoles = new Set(draft.memberOf);
  const ref = (k: string) => {
    const a = parseAccountKey(k);
    return accountRef(kind, a.name, a.host);
  };
  for (const r of draft.memberOf) if (!prevRoles.has(r)) out.push(`GRANT ${ref(r)} TO ${target};`);
  for (const r of prevRoles) if (!nextRoles.has(r)) out.push(`REVOKE ${ref(r)} FROM ${target};`);
  // MySQL / MariaDB : un rôle accordé n'est actif à la connexion que s'il est rôle par défaut
  const rolesChanged = draft.memberOf.some((r) => !prevRoles.has(r)) || [...prevRoles].some((r) => !nextRoles.has(r));
  if (kind === 'mysql' && !draft.isRole && rolesChanged) {
    if (opts.flavor === 'mariadb') out.push(draft.memberOf.length ? `SET DEFAULT ROLE ${ref(draft.memberOf[0])} FOR ${target};` : `SET DEFAULT ROLE NONE FOR ${target};`);
    else out.push(draft.memberOf.length ? `SET DEFAULT ROLE ALL TO ${target};` : `SET DEFAULT ROLE NONE TO ${target};`);
  }

  // droits
  const prev = new Map((before?.objects ?? []).map((o) => [o.key, o]));
  for (const o of objects) out.push(...privDiff(kind, prev.get(o.key), o, target));
  return out;
}

/** Droits par défaut PG : appliqués aux objets créés plus tard dans le schéma (par l'utilisateur connecté). */
export function defaultPrivilegesScript(schema: string, role: string, preset: Preset['id']): string[] {
  const q = (n: string) => qi('postgres', n);
  const r = q(role);
  const s = q(schema);
  const tables = presetPrivileges('postgres', preset, 'table');
  const seqs = presetPrivileges('postgres', preset, 'sequence');
  const fns = presetPrivileges('postgres', preset, 'function');
  const out: string[] = [];
  if (preset === 'none') {
    out.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON TABLES FROM ${r};`);
    out.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON SEQUENCES FROM ${r};`);
    out.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON FUNCTIONS FROM ${r};`);
    return out;
  }
  if (tables.length) out.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ${tables.join(', ')} ON TABLES TO ${r};`);
  if (seqs.length) out.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ${seqs.join(', ')} ON SEQUENCES TO ${r};`);
  if (fns.length) out.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT ${fns.join(', ')} ON FUNCTIONS TO ${r};`);
  return out;
}

/** Suppression d'un compte. PG : les objets possédés dans la base courante sont réattribués ou supprimés. */
export function dropRoleScript(kind: DbKind, role: RoleInfo, opts: { reassignTo?: string; dropOwned?: boolean } = {}): string[] {
  const target = accountRef(kind, role.name, role.host);
  if (kind === 'postgres') {
    const out: string[] = [];
    if (opts.reassignTo) out.push(`REASSIGN OWNED BY ${target} TO ${qi(kind, opts.reassignTo)};`);
    if (opts.dropOwned || opts.reassignTo) out.push(`DROP OWNED BY ${target};`);
    out.push(`DROP ROLE ${target};`);
    return out;
  }
  return [role.isRole ? `DROP ROLE ${target};` : `DROP USER ${target};`];
}

/** Masque les mots de passe dans un texte SQL (historique, journaux). */
export function redactSecrets(sql: string): string {
  return sql
    .replace(/(\bPASSWORD\s*(?:\(\s*)?)'(?:[^'\\]|''|\\.)*'/gi, "$1'••••••••'")
    .replace(/(\bIDENTIFIED\s+(?:BY|WITH\s+\S+\s+(?:BY|AS))\s+)'(?:[^'\\]|''|\\.)*'/gi, "$1'••••••••'");
}

/** Nouveau compte vierge */
export function emptyRole(kind: DbKind, isRole = false): RoleDraft {
  return {
    name: '',
    host: kind === 'mysql' ? (isRole ? '' : '%') : '',
    isRole,
    canLogin: !isRole,
    superuser: false,
    createDb: false,
    createRole: false,
    replication: false,
    bypassRls: false,
    inherit: true,
    connLimit: kind === 'postgres' ? -1 : 0,
    validUntil: null,
    locked: false,
    hasPassword: false,
    comment: null,
    memberOf: [],
    password: '',
  };
}

/** Mot de passe aléatoire lisible (sans caractères ambigus ni guillemets) */
export function generatePassword(len = 20): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789-_.!@#%+=';
  const a = new Uint32Array(len);
  globalThis.crypto.getRandomValues(a);
  return [...a].map((n) => chars[n % chars.length]).join('');
}
