// Lecture des utilisateurs, rôles et droits (PostgreSQL, MySQL, MariaDB).
import crypto from 'node:crypto';
import type { Driver } from './drivers/base';
import {
  accountKey,
  Flavor,
  lit,
  objectKey,
  parseMysqlGrants,
  PrivObject,
  PrivObjectType,
  RoleDetail,
  RoleInfo,
} from '../shared/roles';
import type { CellValue } from '../shared/types';

type Row = Record<string, CellValue>;

async function query(d: Driver, db: string, sql: string, sid: string): Promise<Row[]> {
  const [r] = await d.execute(sid, db, [sql], 1_000_000);
  if (r.error) throw new Error(r.error);
  return r.rows.map((row) => Object.fromEntries(r.fields.map((f, i) => [f.name, row[i]])));
}

/** Exécute fn dans une session dédiée, fermée ensuite. */
async function withSession<T>(d: Driver, fn: (sid: string) => Promise<T>): Promise<T> {
  const sid = 'roles-' + crypto.randomUUID();
  try {
    return await fn(sid);
  } finally {
    await d.closeSession(sid).catch(() => {});
  }
}

const bool = (v: CellValue) => v === true || v === 't' || v === 1 || v === '1' || v === 'Y' || v === 'y';
const str = (v: CellValue) => (v === null || v === undefined ? '' : String(v));
const json = <T>(v: CellValue, fb: T): T => {
  if (v === null || v === undefined) return fb;
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fb;
  }
};

export async function mysqlFlavor(d: Driver): Promise<Flavor> {
  if (d.kind === 'postgres') return 'postgres';
  return /mariadb/i.test((await d.serverInfo()).version) ? 'mariadb' : 'mysql';
}

// ---------------- PostgreSQL ----------------

async function pgRoles(d: Driver, db: string, sid: string): Promise<RoleInfo[]> {
  let pwd = new Map<string, boolean>();
  try {
    // pg_authid : réservé aux superutilisateurs
    const rows = await query(d, db, `select rolname, rolpassword is not null as has from pg_authid`, sid);
    pwd = new Map(rows.map((r) => [str(r.rolname), bool(r.has)]));
  } catch {
    /* pas superutilisateur */
  }
  const rows = await query(
    d,
    db,
    `select r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole, r.rolreplication, r.rolbypassrls,
            r.rolinherit, r.rolconnlimit, r.rolvaliduntil::text as valid, shobj_description(r.oid, 'pg_authid') as comment,
            coalesce((select json_agg(g.rolname order by g.rolname)::text from pg_auth_members m join pg_roles g on g.oid = m.roleid
                      where m.member = r.oid), '[]') as member_of
       from pg_roles r order by r.rolname`,
    sid,
  );
  return rows.map((r) => {
    const name = str(r.rolname);
    return {
      name,
      host: '',
      isRole: !bool(r.rolcanlogin),
      canLogin: bool(r.rolcanlogin),
      superuser: bool(r.rolsuper),
      createDb: bool(r.rolcreatedb),
      createRole: bool(r.rolcreaterole),
      replication: bool(r.rolreplication),
      bypassRls: bool(r.rolbypassrls),
      inherit: bool(r.rolinherit),
      connLimit: Number(r.rolconnlimit ?? -1),
      validUntil: r.valid && r.valid !== 'infinity' ? str(r.valid) : null,
      locked: false,
      hasPassword: pwd.size ? (pwd.get(name) ?? false) : null,
      comment: r.comment === null ? null : str(r.comment),
      memberOf: json<string[]>(r.member_of, []),
      system: /^pg_/.test(name),
    };
  });
}

async function pgDetail(d: Driver, db: string, name: string, sid: string): Promise<RoleDetail> {
  const roles = await pgRoles(d, db, sid);
  const role = roles.find((r) => r.name === name);
  if (!role) throw new Error(`Rôle « ${name} » introuvable.`);
  const n = lit('postgres', name);
  // Les ACL NULL valent les droits par défaut (propriétaire + PUBLIC) : acldefault() les rend explicites.
  const rows = await query(
    d,
    db,
    `with g as (select oid from pg_roles where rolname = ${n}),
     objs as (
       select 'database' as type, null::text as schema, d.datname::text as name, null::text as args, d.datdba as owner,
              coalesce(d.datacl, acldefault('d'::"char", d.datdba)) as acl
         from pg_database d where d.datallowconn and not d.datistemplate
       union all
       select 'schema', null, n.nspname, null, n.nspowner, coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))
         from pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
       union all
       select case c.relkind when 'S' then 'sequence' when 'v' then 'view' when 'm' then 'view' else 'table' end,
              n.nspname, c.relname, null, c.relowner,
              coalesce(c.relacl, acldefault((case when c.relkind = 'S' then 's' else 'r' end)::"char", c.relowner))
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm', 'f', 'S') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
          and not c.relispartition
       union all
       select case p.prokind when 'p' then 'procedure' else 'function' end, n.nspname, p.proname,
              pg_get_function_identity_arguments(p.oid), p.proowner, coalesce(p.proacl, acldefault('f'::"char", p.proowner))
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where p.prokind in ('f', 'p') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
          and not exists (select 1 from pg_depend dep where dep.objid = p.oid and dep.deptype = 'e')
     )
     select o.type, o.schema, o.name, o.args, pg_get_userbyid(o.owner) as owner, o.owner = (select oid from g) as is_owner,
            coalesce((select json_agg(json_build_array(a.privilege_type, a.is_grantable))::text
                        from aclexplode(o.acl) a where a.grantee = (select oid from g)), '[]') as privs
       from objs o
      order by case o.type when 'database' then 0 when 'schema' then 1 else 2 end, o.schema nulls first, o.name`,
    sid,
  );
  const objects: PrivObject[] = rows.map((r) => {
    const privs = json<[string, boolean][]>(r.privs, []);
    const o: PrivObject = {
      key: '',
      type: str(r.type) as PrivObjectType,
      schema: r.schema === null ? undefined : str(r.schema),
      name: str(r.name),
      args: r.args === null ? undefined : str(r.args),
      owner: str(r.owner),
      isOwner: bool(r.is_owner),
      privileges: privs.map((p) => p[0]),
      grantable: privs.filter((p) => p[1]).map((p) => p[0]),
    };
    o.key = objectKey(o);
    return o;
  });
  const members = roles.filter((r) => r.memberOf.includes(name)).map((r) => r.name);
  return { role, objects, members, other: [] };
}

// ---------------- MySQL / MariaDB ----------------

const SYSTEM_MY = /^(mariadb\.sys|mysql\.sys|mysql\.session|mysql\.infoschema|PUBLIC)$/;

async function myRoles(d: Driver, sid: string): Promise<RoleInfo[]> {
  const rows = await query(d, '', 'select * from mysql.user', sid);
  let edges: Row[] = [];
  try {
    // MySQL 8 : rôles accordés
    edges = await query(d, '', 'select FROM_USER, FROM_HOST, TO_USER, TO_HOST from mysql.role_edges', sid);
  } catch {
    try {
      // MariaDB
      const m = await query(d, '', 'select User, Host, Role from mysql.roles_mapping', sid);
      edges = m.map((r) => ({ FROM_USER: r.Role, FROM_HOST: '', TO_USER: r.User, TO_HOST: r.Host }));
    } catch {
      /* pas d'accès */
    }
  }
  // MariaDB : le verrouillage n'est visible que dans mysql.global_priv (JSON)
  const lockedKeys = new Set<string>();
  if (rows.length && rows[0].account_locked === undefined) {
    try {
      const g = await query(d, '', `select User, Host from mysql.global_priv where json_value(Priv, '$.account_locked') in ('true', '1')`, sid);
      for (const r of g) lockedKeys.add(accountKey(str(r.User), str(r.Host)));
    } catch {
      /* pas d'accès */
    }
  }
  const roleKeys = new Set(edges.map((e) => accountKey(str(e.FROM_USER), str(e.FROM_HOST))));
  return rows
    .map((r) => {
      const name = str(r.User);
      const host = str(r.Host);
      const key = accountKey(name, host);
      const isRole = r.is_role !== undefined ? bool(r.is_role) : roleKeys.has(key) && bool(r.account_locked) && !str(r.authentication_string);
      const auth = str(r.authentication_string ?? r.Password ?? '');
      const memberOf = edges
        .filter((e) => str(e.TO_USER) === name && str(e.TO_HOST) === host)
        .map((e) => accountKey(str(e.FROM_USER), str(e.FROM_HOST)))
        .sort();
      return {
        name,
        host,
        isRole,
        canLogin: !isRole,
        superuser: bool(r.Super_priv) || (bool(r.Grant_priv) && bool(r.Create_user_priv)),
        createDb: bool(r.Create_priv),
        createRole: bool(r.Create_user_priv),
        replication: bool(r.Repl_slave_priv),
        bypassRls: false,
        inherit: true,
        connLimit: Number(r.max_user_connections ?? 0),
        validUntil: null,
        locked: bool(r.account_locked) || lockedKeys.has(key),
        hasPassword: isRole ? false : auth.length > 0 && auth !== 'invalid',
        comment: null,
        memberOf,
        system: SYSTEM_MY.test(name) || name === '',
      } satisfies RoleInfo;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.host.localeCompare(b.host));
}

async function myDetail(d: Driver, scopeDb: string, name: string, host: string, sid: string): Promise<RoleDetail> {
  const roles = await myRoles(d, sid);
  const role = roles.find((r) => r.name === name && r.host === host);
  if (!role) throw new Error(`Compte « ${accountKey(name, host)} » introuvable.`);
  const ref = host || !role.isRole ? `${lit('mysql', name)}@${lit('mysql', host)}` : lit('mysql', name);
  const grants = await query(d, '', `SHOW GRANTS FOR ${ref}`, sid);
  const parsed = parseMysqlGrants(grants.map((g) => str(Object.values(g)[0])));
  role.memberOf = [...new Set([...role.memberOf, ...parsed.roles])].sort();

  const objects = new Map<string, PrivObject>();
  const put = (o: Omit<PrivObject, 'key' | 'privileges' | 'grantable'>) => {
    const k = objectKey(o);
    if (!objects.has(k)) objects.set(k, { ...o, key: k, privileges: [], grantable: [] });
    return objects.get(k)!;
  };
  put({ type: 'global', name: '*.*' });
  const dbs = await query(d, '', 'SHOW DATABASES', sid);
  for (const r of dbs) {
    const n = str(Object.values(r)[0]);
    if (!/^(information_schema|performance_schema)$/i.test(n)) put({ type: 'database', name: n });
  }
  if (scopeDb) {
    const objs = await query(
      d,
      '',
      `select table_name as n, table_type as t from information_schema.tables where table_schema = ${lit('mysql', scopeDb)} order by table_name`,
      sid,
    );
    for (const r of objs) put({ type: /VIEW/i.test(str(r.t)) ? 'view' : 'table', database: scopeDb, name: str(r.n) });
    const routines = await query(
      d,
      '',
      `select routine_name as n, routine_type as t from information_schema.routines where routine_schema = ${lit('mysql', scopeDb)} order by routine_name`,
      sid,
    );
    for (const r of routines) put({ type: /PROCEDURE/i.test(str(r.t)) ? 'procedure' : 'function', database: scopeDb, name: str(r.n) });
  }
  for (const g of parsed.objects) {
    // une table accordée par GRANT … ON `db`.`v` peut être une vue : on la rattache à l'objet connu
    let o =
      objects.get(objectKey({ type: g.type, database: g.database, name: g.name })) ??
      (g.type === 'table' ? objects.get(objectKey({ type: 'view', database: g.database, name: g.name })) : undefined);
    if (!o) o = put({ type: g.type, database: g.database, name: g.name });
    for (const p of g.privileges) if (!o.privileges.includes(p)) o.privileges.push(p);
    if (g.grantable) o.grantable = [...o.privileges];
  }
  const members = roles.filter((r) => r.memberOf.includes(accountKey(name, host))).map((r) => accountKey(r.name, r.host));
  return { role, objects: [...objects.values()], members, other: parsed.other };
}

// ---------------- API ----------------

export async function listRoles(d: Driver, db: string): Promise<{ flavor: Flavor; roles: RoleInfo[]; currentUser: string }> {
  const flavor = await mysqlFlavor(d);
  const currentUser = (await d.serverInfo()).currentUser;
  return withSession(d, async (sid) => ({
    flavor,
    currentUser,
    roles: d.kind === 'postgres' ? await pgRoles(d, db, sid) : await myRoles(d, sid),
  }));
}

export async function roleDetail(d: Driver, db: string, name: string, host: string): Promise<RoleDetail> {
  return withSession(d, (sid) => (d.kind === 'postgres' ? pgDetail(d, db, name, sid) : myDetail(d, db, name, host, sid)));
}

/** Applique un script de comptes : transaction sous PostgreSQL, instruction par instruction sous MySQL. */
export async function applyRoleScript(d: Driver, db: string, statements: string[]): Promise<{ done: number; error?: string; statement?: string }> {
  return withSession(d, async (sid) => {
    const pg = d.kind === 'postgres';
    if (pg) await query(d, db, 'BEGIN', sid);
    let done = 0;
    for (const s of statements) {
      const [r] = await d.execute(sid, db, [s.replace(/;\s*$/, '')], 0);
      if (r.error) {
        if (pg) await d.execute(sid, db, ['ROLLBACK'], 0).catch(() => {});
        return { done: pg ? 0 : done, error: r.error, statement: s };
      }
      done++;
    }
    if (pg) await query(d, db, 'COMMIT', sid);
    if (!pg) await d.execute(sid, db, ['FLUSH PRIVILEGES'], 0).catch(() => {});
    return { done };
  });
}
