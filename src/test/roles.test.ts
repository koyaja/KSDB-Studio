// Tests des utilisateurs et droits : analyse, génération du SQL, puis application sur de vrais serveurs.
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../shared/types';
import { createDriver } from '../main/connections';
import type { Driver } from '../main/drivers/base';
import { applyRoleScript, listRoles, roleDetail } from '../main/roles';
import {
  buildRoleScript,
  defaultPrivilegesScript,
  dropRoleScript,
  emptyRole,
  parseMysqlGrants,
  presetPrivileges,
  PrivObject,
  redactSecrets,
  RoleDraft,
} from '../shared/roles';

const env = process.env;
const pgCfg: ConnectionConfig = {
  id: 'pg',
  name: 'PG',
  kind: 'postgres',
  host: '127.0.0.1',
  port: Number(env.KSDB_PG_PORT ?? 5432),
  user: env.KSDB_PG_USER ?? 'postgres',
  password: env.KSDB_PG_PASS ?? 'secret',
  savePassword: true,
  database: 'boutique',
  ssl: { mode: 'disable' },
  ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password' },
};
const myCfg: ConnectionConfig = { ...pgCfg, id: 'my', kind: 'mysql', port: Number(env.KSDB_MY_PORT ?? 3306), user: env.KSDB_MY_USER ?? 'ks', password: env.KSDB_MY_PASS ?? 'secret', database: '' };

let failed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(e as Error).stack?.split('\n').slice(0, 6).join('\n    ')}`);
  }
}

async function apply(d: Driver, db: string, stmts: string[]) {
  const r = await applyRoleScript(d, db, stmts);
  if (r.error) throw new Error(`${r.error}\n--- ${r.statement}`);
  return r;
}

/** Exécute une requête avec un autre compte ; renvoie l'erreur éventuelle */
async function as(cfg: ConnectionConfig, db: string, sql: string): Promise<string | null> {
  const { driver, dispose } = createDriver(cfg);
  try {
    const [r] = await driver.execute('x', db, [sql], 10);
    return r.error ?? null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await driver.close().catch(() => {});
    dispose();
  }
}

const withPreset = (kind: 'postgres' | 'mysql', objects: PrivObject[], filter: (o: PrivObject) => boolean, preset: 'read' | 'write' | 'all' | 'none') =>
  objects.map((o) => (filter(o) && !o.isOwner ? { ...o, privileges: presetPrivileges(kind, preset, o.type) } : o));

async function main() {
  console.log('Analyse et génération');
  await t('SHOW GRANTS MariaDB / MySQL 8', () => {
    const p = parseMysqlGrants([
      "GRANT USAGE ON *.* TO `bob`@`%` IDENTIFIED BY PASSWORD '*AAA'",
      'GRANT SELECT, INSERT, SHOW VIEW ON `boutique`.* TO `bob`@`%`',
      'GRANT SELECT (`id`, `nom`), UPDATE ON `boutique`.`clients` TO `bob`@`%`',
      'GRANT EXECUTE ON PROCEDURE `boutique`.`maj` TO `bob`@`%`',
      'GRANT ALL PRIVILEGES ON `app\\_test`.* TO `bob`@`%` WITH GRANT OPTION',
      'GRANT SELECT ON `app_%`.* TO `bob`@`%`',
      'GRANT `lecteur` TO `bob`@`%`',
      'GRANT `r1`@`%`,`r2`@`%` TO `bob`@`%`',
      "GRANT PROXY ON ''@'%' TO 'root'@'localhost' WITH GRANT OPTION",
      'GRANT APPLICATION_PASSWORD_ADMIN,AUDIT_ADMIN ON *.* TO `root`@`localhost`',
    ]);
    const by = (n: string) => p.objects.findLast((o) => o.name === n)!;
    assert.deepEqual(by('*.*').privileges.slice(-2), ['APPLICATION_PASSWORD_ADMIN', 'AUDIT_ADMIN']);
    assert.deepEqual(by('boutique').privileges, ['SELECT', 'INSERT', 'SHOW VIEW']);
    assert.deepEqual(by('clients').privileges, ['UPDATE']);
    assert.equal(by('maj').type, 'procedure');
    assert.ok(by('app_test').all && by('app_test').grantable);
    assert.deepEqual(p.roles, ['lecteur', 'r1@%', 'r2@%']);
    assert.equal(p.other.length, 3); // colonnes, motif app_%, PROXY
  });
  await t('création PG : attributs, mot de passe masqué dans l’aperçu', () => {
    const d: RoleDraft = { ...emptyRole('postgres'), name: 'app', password: "p'w", connLimit: 3, createDb: true, memberOf: ['lecteurs'] };
    const s = buildRoleScript('postgres', null, d, [], { mask: true });
    assert.equal(s[0], `CREATE ROLE "app" WITH CREATEDB LOGIN CONNECTION LIMIT 3 PASSWORD '••••••••';`);
    assert.equal(s[1], 'GRANT "lecteurs" TO "app";');
    assert.match(buildRoleScript('postgres', null, d, [])[0], /PASSWORD 'p''w'/);
  });
  await t('masquage des mots de passe dans l’historique', () => {
    assert.equal(redactSecrets(`ALTER ROLE a PASSWORD 'secret'`), `ALTER ROLE a PASSWORD '••••••••'`);
    assert.equal(redactSecrets(`create user 'u'@'%' identified by 'x\\'y'`), `create user 'u'@'%' identified by '••••••••'`);
    assert.equal(redactSecrets(`SET PASSWORD FOR u = PASSWORD('abc')`), `SET PASSWORD FOR u = PASSWORD('••••••••')`);
    assert.equal(redactSecrets(`select 'password'`), `select 'password'`);
  });

  const { driver: pg, dispose: d1 } = createDriver(pgCfg);
  const { driver: my, dispose: d2 } = createDriver(myCfg);
  const cleanPg = () =>
    applyRoleScript(pg, 'boutique', [
      'DROP OWNED BY ks_app',
      'DROP ROLE IF EXISTS ks_app',
      'DROP ROLE IF EXISTS ks_app2',
      'DROP OWNED BY ks_lecteurs',
      'DROP ROLE IF EXISTS ks_lecteurs',
    ]).catch(() => {});
  try {
    for (const s of ['DROP OWNED BY ks_app', 'DROP ROLE IF EXISTS ks_app', 'DROP OWNED BY ks_app2', 'DROP ROLE IF EXISTS ks_app2', 'DROP OWNED BY ks_lecteurs', 'DROP ROLE IF EXISTS ks_lecteurs'])
      await applyRoleScript(pg, 'boutique', [s]).catch(() => {});

    console.log('\nPostgreSQL');
    await t('créer un groupe et un utilisateur membre', async () => {
      await apply(pg, 'boutique', buildRoleScript('postgres', null, { ...emptyRole('postgres', true), name: 'ks_lecteurs', comment: 'Lecture seule' }, []));
      const draft: RoleDraft = { ...emptyRole('postgres'), name: 'ks_app', password: 'Mot2Passe!', connLimit: 5, validUntil: '2030-01-01', memberOf: ['ks_lecteurs'] };
      await apply(pg, 'boutique', buildRoleScript('postgres', null, draft, []));
      const { roles } = await listRoles(pg, 'boutique');
      const r = roles.find((x) => x.name === 'ks_app')!;
      assert.ok(r.canLogin && !r.isRole && r.hasPassword);
      assert.equal(r.connLimit, 5);
      assert.match(r.validUntil!, /^2030-01-01/);
      assert.deepEqual(r.memberOf, ['ks_lecteurs']);
      const g = roles.find((x) => x.name === 'ks_lecteurs')!;
      assert.ok(g.isRole && g.comment === 'Lecture seule');
    });
    await t('droits « lecture seule » sur le schéma public via le groupe : SELECT oui, INSERT non', async () => {
      const det = await roleDetail(pg, 'boutique', 'ks_lecteurs', '');
      const objs = withPreset('postgres', det.objects, (o) => (o.type === 'database' && o.name === 'boutique') || o.name === 'public' || o.schema === 'public', 'read');
      const script = buildRoleScript('postgres', det, det.role, objs);
      assert.ok(script.includes('GRANT CONNECT ON DATABASE "boutique" TO "ks_lecteurs";'), script.join('\n'));
      assert.ok(script.includes('GRANT SELECT ON TABLE "public"."clients" TO "ks_lecteurs";'));
      await apply(pg, 'boutique', script);
      const app = { ...pgCfg, user: 'ks_app', password: 'Mot2Passe!' };
      assert.equal(await as(app, 'boutique', 'select count(*) from public.clients'), null);
      assert.match((await as(app, 'boutique', "insert into public.clients(nom) values ('x')")) ?? '', /permission denied|droit refusé/);
      // relecture : plus aucune différence
      const again = await roleDetail(pg, 'boutique', 'ks_lecteurs', '');
      assert.deepEqual(buildRoleScript('postgres', again, again.role, objs.map((o) => ({ ...o }))), []);
      assert.ok(again.objects.find((o) => o.name === "clients" && o.schema === "public")!.privileges.includes('SELECT'));
    });
    await t('modifier : renommer, retirer du groupe, supprimer le mot de passe', async () => {
      const det = await roleDetail(pg, 'boutique', 'ks_app', '');
      const script = buildRoleScript('postgres', det, { ...det.role, name: 'ks_app2', memberOf: [], clearPassword: true, connLimit: -1, validUntil: null }, det.objects);
      assert.equal(script[0], 'ALTER ROLE "ks_app" RENAME TO "ks_app2";');
      await apply(pg, 'boutique', script);
      const r = (await listRoles(pg, 'boutique')).roles.find((x) => x.name === 'ks_app2')!;
      assert.ok(r && !r.hasPassword && r.memberOf.length === 0 && r.connLimit === -1 && r.validUntil === null);
    });
    await t('erreur : transaction annulée, rien n’est appliqué', async () => {
      const r = await applyRoleScript(pg, 'boutique', ['CREATE ROLE ks_app', 'GRANT SELECT ON TABLE public.inexistante TO ks_app']);
      assert.ok(r.error);
      assert.ok(!(await listRoles(pg, 'boutique')).roles.some((x) => x.name === 'ks_app'));
    });
    await t('droits par défaut et suppression avec réattribution', async () => {
      await apply(pg, 'boutique', defaultPrivilegesScript('public', 'ks_lecteurs', 'read'));
      await apply(pg, 'boutique', ['CREATE TABLE public.ks_tmp(id int)', 'ALTER TABLE public.ks_tmp OWNER TO ks_app2']);
      const det = await roleDetail(pg, 'boutique', 'ks_lecteurs', '');
      assert.ok(det.objects.find((o) => o.name === 'ks_tmp')!.privileges.includes('SELECT'), 'droits par défaut appliqués');
      const own = await roleDetail(pg, 'boutique', 'ks_app2', '');
      assert.ok(own.objects.find((o) => o.name === 'ks_tmp')!.isOwner);
      await apply(pg, 'boutique', dropRoleScript('postgres', own.role, { reassignTo: 'postgres' }));
      await apply(pg, 'boutique', defaultPrivilegesScript('public', 'ks_lecteurs', 'none'));
      await apply(pg, 'boutique', ['DROP TABLE public.ks_tmp']);
      const g = await roleDetail(pg, 'boutique', 'ks_lecteurs', '');
      await apply(pg, 'boutique', dropRoleScript('postgres', g.role, { dropOwned: true }));
      const names = (await listRoles(pg, 'boutique')).roles.map((r) => r.name);
      assert.ok(!names.includes('ks_app2') && !names.includes('ks_lecteurs'));
    });

    console.log('\nMariaDB');
    for (const s of ["DROP USER IF EXISTS 'ks_app'@'%'", "DROP USER IF EXISTS 'ks_app2'@'localhost'", 'DROP ROLE IF EXISTS ks_lecteur'])
      await applyRoleScript(my, '', [s]).catch(() => {});
    await t('rôle + utilisateur, rôle par défaut, lecture seule sur boutique', async () => {
      const { flavor } = await listRoles(my, '');
      assert.equal(flavor, 'mariadb');
      await apply(my, '', buildRoleScript('mysql', null, { ...emptyRole('mysql', true), name: 'ks_lecteur' }, [], { flavor }));
      const role = await roleDetail(my, 'boutique', 'ks_lecteur', '');
      assert.ok(role.role.isRole);
      const objs = withPreset('mysql', role.objects, (o) => o.type === 'database' && o.name === 'boutique', 'read');
      await apply(my, '', buildRoleScript('mysql', role, role.role, objs, { flavor }));
      const draft: RoleDraft = { ...emptyRole('mysql'), name: 'ks_app', password: "Mo't2\\Passe", connLimit: 4, memberOf: ['ks_lecteur'] };
      const script = buildRoleScript('mysql', null, draft, [], { flavor });
      assert.ok(script.includes('SET DEFAULT ROLE `ks_lecteur` FOR `ks_app`@`%`;'), script.join('\n'));
      await apply(my, '', script);
      const app = { ...myCfg, user: 'ks_app', password: "Mo't2\\Passe" };
      assert.equal(await as(app, '', 'select count(*) from boutique.clients'), null);
      assert.match((await as(app, '', "insert into boutique.journal(message) values ('x')")) ?? '', /denied/i);
      const u = (await listRoles(my, '')).roles.find((r) => r.name === 'ks_app')!;
      assert.equal(u.connLimit, 4);
      assert.deepEqual(u.memberOf, ['ks_lecteur']);
      const again = await roleDetail(my, 'boutique', 'ks_lecteur', '');
      assert.deepEqual(buildRoleScript('mysql', again, again.role, objs, { flavor }), []);
    });
    await t('droits sur une table et un global, verrouillage, renommage', async () => {
      const { flavor } = await listRoles(my, '');
      const det = await roleDetail(my, 'boutique', 'ks_app', '%');
      const objs = det.objects.map((o) =>
        o.type === 'table' && o.name === 'journal' ? { ...o, privileges: ['SELECT', 'INSERT'] } : o.type === 'global' ? { ...o, privileges: ['PROCESS'] } : o,
      );
      await apply(my, '', buildRoleScript('mysql', det, { ...det.role, locked: true, host: 'localhost', name: 'ks_app2' }, objs, { flavor }));
      const d2 = await roleDetail(my, 'boutique', 'ks_app2', 'localhost');
      assert.ok(d2.role.locked);
      assert.deepEqual(d2.objects.find((o) => o.name === 'journal')!.privileges, ['SELECT', 'INSERT']);
      assert.deepEqual(d2.objects.find((o) => o.type === 'global')!.privileges, ['PROCESS']);
      await apply(my, '', buildRoleScript('mysql', d2, d2.role, d2.objects.map((o) => (o.name === 'journal' ? { ...o, privileges: ['SELECT'] } : o)), { flavor }));
      assert.deepEqual((await roleDetail(my, 'boutique', 'ks_app2', 'localhost')).objects.find((o) => o.name === 'journal')!.privileges, ['SELECT']);
    });
    await t('suppression', async () => {
      const { roles } = await listRoles(my, '');
      for (const r of roles.filter((x) => x.name.startsWith('ks_') && x.name !== 'ks')) await apply(my, '', dropRoleScript('mysql', r));
      assert.ok(!(await listRoles(my, '')).roles.some((x) => x.name.startsWith('ks_')));
    });
  } finally {
    await cleanPg();
    await pg.close();
    await my.close();
    d1();
    d2();
  }
  console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests des comptes passent');
  process.exit(failed ? 1 : 0);
}

main();
