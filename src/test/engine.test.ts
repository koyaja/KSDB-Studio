// Tests d'intégration du moteur (sans Electron).
// Variables : PG_URL-like via env KSDB_PG_* / KSDB_MY_* ; valeurs par défaut = serveurs locaux de dev.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitSql, statementAt, isRisky } from '../shared/sqlsplit';
import type { ConnectionConfig, Settings } from '../shared/types';
import { ConnectionManager, createDriver } from '../main/connections';
import { CsvParser, makeWriter } from '../main/csv';
import { decryptNavicat, encryptNavicat, parseNcx } from '../main/navicat';
import { dump, restore, toolStatus } from '../main/tools';

const env = process.env;
const pgCfg: ConnectionConfig = {
  id: 'pg',
  name: 'PG local',
  kind: 'postgres',
  host: env.KSDB_PG_HOST ?? '127.0.0.1',
  port: Number(env.KSDB_PG_PORT ?? 5432),
  user: env.KSDB_PG_USER ?? 'postgres',
  password: env.KSDB_PG_PASS ?? 'secret',
  savePassword: true,
  database: 'boutique',
  ssl: { mode: 'disable' },
  ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password' },
};
const myCfg: ConnectionConfig = {
  ...pgCfg,
  id: 'my',
  name: 'MariaDB local',
  kind: 'mysql',
  port: Number(env.KSDB_MY_PORT ?? 3306),
  user: env.KSDB_MY_USER ?? 'ks',
  password: env.KSDB_MY_PASS ?? 'secret',
};
const settings: Settings = { theme: 'dark', maxRows: 1000, pageSize: 100, editorFontSize: 13, uppercaseKeywords: true, binaries: {} };

let failed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(e as Error).stack?.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

async function main() {
  console.log('Découpage SQL');
  await t('split PG avec dollar-quoting et commentaires', () => {
    const s = splitSql(
      "select 1; -- a;b\ncreate function f() returns int as $$ select 1; $$ language sql; select 'x;y'; /* ; */ select E'a\\';b';",
      'postgres',
    );
    assert.equal(s.length, 4);
    assert.match(s[1].text, /\$\$ select 1; \$\$/);
  });
  await t('split MySQL avec DELIMITER', () => {
    const s = splitSql('select 1;\nDELIMITER //\ncreate procedure p() begin select 1; select 2; end//\nDELIMITER ;\nselect `a;b`;', 'mysql');
    assert.equal(s.length, 3);
    assert.match(s[1].text, /begin select 1; select 2; end$/);
  });
  await t('instruction sous le curseur', () => {
    const sql = 'select 1;\n\nselect 2;\nselect 3';
    assert.equal(statementAt(sql, 'postgres', sql.indexOf('2'))?.text, 'select 2');
    assert.equal(statementAt(sql, 'postgres', sql.length)?.text, 'select 3');
  });
  await t('détection requêtes risquées', () => {
    assert.ok(isRisky('delete from t'));
    assert.ok(!isRisky('delete from t where id=1'));
    assert.ok(isRisky('DROP TABLE x'));
  });

  console.log('Navicat / CSV');
  await t('chiffrement Navicat aller-retour', () => {
    assert.equal(decryptNavicat(encryptNavicat('Mot2Passe!é')), 'Mot2Passe!é');
  });
  await t('import .ncx', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><Connections Ver="1.5">
      <Connection ConnectionName="Prod PG" ConnType="POSTGRESQL" Host="10.0.0.5" Port="5432" UserName="app" Password="${encryptNavicat('pw1')}" SavePassword="true" Database="erp" SSH="true" SSH_Host="bastion" SSH_Port="22" SSH_UserName="root" SSH_AuthenMethod="PUBLICKEY" SSH_PrivateKey="C:\\keys\\id_rsa" />
      <Connection ConnectionName="Maria" ConnType="MARIADB" Host="localhost" Port="3307" UserName="root" Password="${encryptNavicat('pw2')}" />
      <Connection ConnectionName="Ora" ConnType="ORACLE" Host="x" />
    </Connections>`;
    const r = parseNcx(xml);
    assert.equal(r.connections.length, 2);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.connections[0].password, 'pw1');
    assert.equal(r.connections[0].ssh.auth, 'key');
    assert.equal(r.connections[0].database, 'erp');
    assert.equal(r.connections[1].flavor, 'mariadb');
    assert.equal(r.connections[1].port, 3307);
  });
  await t('parser CSV (guillemets, sauts de ligne, chunks)', () => {
    const p = new CsvParser(';');
    const text = 'a;b;c\n1;"x;y";"multi\nligne"\n2;"dit ""bonjour""";\r\n';
    for (let i = 0; i < text.length; i += 3) p.feed(text.slice(i, i + 3));
    p.end();
    const rows = p.take();
    assert.deepEqual(rows, [['a', 'b', 'c'], ['1', 'x;y', 'multi\nligne'], ['2', 'dit "bonjour"', '']]);
  });
  await t('écriture CSV', () => {
    const w = makeWriter('csv', { literal: String, quoteIdent: String });
    assert.equal(w.rows([['a,b', null, 'x"y']], []), '"a,b",,"x""y"\r\n');
  });

  for (const cfg of [pgCfg, myCfg]) {
    console.log(`\n${cfg.name}`);
    const { driver: d, dispose } = createDriver(cfg);
    const db = 'boutique';
    const schema = cfg.kind === 'postgres' ? 'public' : 'boutique';
    try {
      await t('connexion + version', async () => {
        const info = await d.serverInfo();
        assert.ok(info.version.length > 5);
        console.log(`    ${info.version.slice(0, 70)}`);
      });
      await t('bases et schémas', async () => {
        assert.ok((await d.listDatabases()).includes(db));
        const s = await d.listSchemas(db);
        assert.ok(s.includes(schema));
        if (cfg.kind === 'postgres') assert.ok(s.includes('ventes'));
      });
      await t('objets', async () => {
        const o = await d.listObjects(db, schema);
        const names = o.map((x) => `${x.type}:${x.name}`);
        for (const n of ['table:clients', 'table:journal', 'function:total_client', 'trigger:trg_trim'])
          assert.ok(names.includes(n), `manque ${n} dans ${names.join(',')}`);
        assert.ok(o.some((x) => x.type === 'view'));
        if (cfg.kind === 'mysql') assert.ok(names.includes('procedure:p_hello'));
      });
      await t('structure de table', async () => {
        const st = await d.structure(db, schema, 'clients');
        assert.deepEqual(st.primaryKey, ['id']);
        const nom = st.columns.find((c) => c.name === 'nom')!;
        assert.equal(nom.nullable, false);
        assert.equal(nom.comment, 'Nom complet');
        assert.ok(st.columns.find((c) => c.name === 'id')!.autoIncrement);
        assert.ok(st.indexes.some((i) => i.unique && i.columns.includes('email')));
        const solde = st.columns.find((c) => c.name === 'solde')!;
        assert.ok(solde.default !== null, 'défaut de solde');
      });
      await t('clés étrangères', async () => {
        const cs = cfg.kind === 'postgres' ? 'ventes' : schema;
        const st = await d.structure(db, cs, 'commandes');
        assert.equal(st.foreignKeys.length, 1);
        assert.equal(st.foreignKeys[0].refTable, 'clients');
        assert.equal(st.foreignKeys[0].onDelete, 'CASCADE');
      });
      await t('modèle ERD (tables, PK, FK)', async () => {
        const m = await d.erdModel(db, schema);
        const cl = m.tables.find((x) => x.name === 'clients')!;
        assert.ok(cl, 'table clients');
        assert.ok(cl.columns.find((c) => c.name === 'id')!.pk);
        assert.ok(m.tables.some((x) => x.kind === 'view'));
        if (cfg.kind === 'mysql') {
          const r = m.relations.find((x) => x.from === 'commandes')!;
          assert.deepEqual([r.to, r.fromColumns[0], r.toColumns[0], r.onDelete], ['clients', 'client_id', 'id', 'CASCADE']);
          assert.ok(m.tables.find((x) => x.name === 'commandes')!.columns.find((c) => c.name === 'client_id')!.fk);
        } else {
          const v = await d.erdModel(db, 'ventes');
          const r = v.relations[0];
          assert.deepEqual([r.from, r.toSchema, r.to, r.onDelete], ['commandes', 'public', 'clients', 'CASCADE']);
          assert.ok(v.tables[0].columns.find((c) => c.name === 'client_id')!.fk);
        }
      });
      await t('DDL table / vue / fonction / trigger', async () => {
        const t1 = await d.ddl(db, schema, 'clients', 'table');
        assert.match(t1, /CREATE TABLE/i);
        assert.match(t1, /email/);
        const objs = await d.listObjects(db, schema);
        const v = objs.find((o) => o.type === 'view')!;
        assert.match(await d.ddl(db, schema, v.name, 'view'), /VIEW/i);
        const f = objs.find((o) => o.name === 'total_client')!;
        assert.match(await d.ddl(db, schema, f.name, 'function', f.extra), /total_client/);
        const tr = objs.find((o) => o.type === 'trigger')!;
        assert.match(await d.ddl(db, schema, tr.name, 'trigger', tr.extra), /trg_trim/i);
      });
      await t('autocomplétion', async () => {
        const c = await d.completion(db);
        assert.ok(c.schemas[c.defaultSchema]?.clients?.includes('email'));
      });
      await t('exécution multi-instructions + limite de lignes', async () => {
        const sql =
          cfg.kind === 'postgres'
            ? 'select * from clients order by id; update journal set ligne = ligne where false; select 1/0'
            : 'select * from clients order by id; update journal set ligne = ligne where 1=0; select * from table_inexistante';
        const parts = splitSql(sql, d.kind).map((s) => s.text);
        const r = await d.execute('s1', db, parts, 1000);
        assert.equal(r.length, 3);
        assert.equal(r[0].rows.length, 1000);
        assert.equal(r[0].truncated, true);
        assert.equal(r[0].fields[0].name, 'id');
        assert.equal(r[1].affectedRows, 0);
        assert.ok(r[2].error, 'erreur attendue');
      });
      await t('session conservée (transaction sur plusieurs exécutions)', async () => {
        await d.execute('s2', db, ['begin', "insert into journal values ('tx', null)"], 10);
        const inSession = await d.execute('s2', db, ["select count(*) from journal where ligne = 'tx'"], 10);
        assert.equal(String(inSession[0].rows[0][0]), '1');
        await d.execute('s2', db, ['rollback'], 10);
        const after = await d.execute('s2', db, ["select count(*) from journal where ligne = 'tx'"], 10);
        assert.equal(String(after[0].rows[0][0]), '0');
        await d.closeSession('s2');
      });
      await t('annulation de requête longue', async () => {
        const slow = cfg.kind === 'postgres' ? 'select pg_sleep(10)' : 'select sleep(10)';
        const p = d.execute('s3', db, [slow], 10);
        await new Promise((r) => setTimeout(r, 800));
        const t0 = Date.now();
        assert.equal(await d.cancel('s3'), true);
        const r = await p;
        assert.ok(Date.now() - t0 < 3000, 'annulation rapide');
        if (cfg.kind === 'postgres') assert.ok(r[0].error);
        await d.closeSession('s3');
      });
      await t('pagination, tri, filtre', async () => {
        const p = await d.fetchPage(db, schema, 'clients', {
          limit: 50,
          offset: 10,
          where: 'solde > 100',
          orderBy: [{ column: 'solde', dir: 'desc' }],
        });
        assert.equal(p.rows.length, 50);
        assert.equal(p.editable, true);
        assert.deepEqual(p.keyColumns, ['id']);
        assert.equal(await d.count(db, schema, 'clients', 'solde > 100'), 4991);
      });
      await t('table sans clé primaire', async () => {
        const p = await d.fetchPage(db, schema, 'journal', { limit: 10, offset: 0 });
        if (cfg.kind === 'postgres') {
          assert.equal(p.editable, true);
          assert.ok(p.hiddenKey);
        } else assert.equal(p.editable, false);
      });
      await t('édition : insert / update / delete transactionnels', async () => {
        const n = await d.applyChanges(db, schema, 'clients', [
          { type: 'insert', values: { nom: '  Test KSDB  ', email: 'ksdb@test.bj', solde: '42.5' } },
        ]);
        assert.equal(n, 1);
        const r1 = await d.fetchPage(db, schema, 'clients', { limit: 1, offset: 0, where: "email = 'ksdb@test.bj'" });
        const idIdx = r1.fields.findIndex((f) => f.name === 'id');
        const nomIdx = r1.fields.findIndex((f) => f.name === 'nom');
        assert.equal(r1.rows[0][nomIdx], 'Test KSDB'); // trigger trim
        const id = r1.rows[0][idIdx];
        await d.applyChanges(db, schema, 'clients', [{ type: 'update', key: { id }, set: { solde: '99.99', meta: null } }]);
        // mise à jour sans changement réel : ne doit pas échouer
        await d.applyChanges(db, schema, 'clients', [{ type: 'update', key: { id }, set: { solde: '99.99' } }]);
        // échec au milieu => rollback complet
        await assert.rejects(
          d.applyChanges(db, schema, 'clients', [
            { type: 'update', key: { id }, set: { solde: '1' } },
            { type: 'update', key: { id: -999 }, set: { solde: '2' } },
          ]),
        );
        const r2 = await d.fetchPage(db, schema, 'clients', { limit: 1, offset: 0, where: "email = 'ksdb@test.bj'" });
        assert.equal(String(r2.rows[0][r2.fields.findIndex((f) => f.name === 'solde')]), '99.99');
        await d.applyChanges(db, schema, 'clients', [{ type: 'delete', key: { id } }]);
        assert.equal(await d.count(db, schema, 'clients', "email = 'ksdb@test.bj'"), 0);
        const prev = d.previewChanges(cfg.kind === 'mysql' ? db : schema, 'clients', [
          { type: 'update', key: { id: 1 }, set: { nom: "O'Neil" } },
        ]);
        assert.match(prev[0], /O''Neil|O\\'Neil/);
      });
      if (cfg.kind === 'postgres')
        await t('édition via ctid (sans PK)', async () => {
          const p = await d.fetchPage(db, schema, 'journal', { limit: 10, offset: 0, where: "ligne = 'a'" });
          const k = p.rows[0][0];
          await d.applyChanges(db, schema, 'journal', [{ type: 'update', key: { [p.hiddenKey!]: k }, set: { ligne: 'a2' } }], p.hiddenKey);
          assert.equal(await d.count(db, schema, 'journal', "ligne = 'a2'"), 1);
          await d.execute('s4', db, ["update journal set ligne = 'a' where ligne = 'a2'"], 1);
          await d.closeSession('s4');
        });
      await t('itération par lots (export)', async () => {
        let n = 0;
        for await (const b of d.iterate(db, `select * from ${d.qualified(schema, 'clients')}`, 1500)) n += b.rows.length;
        assert.equal(n, 5000);
      });
      await t('import en masse (transaction)', async () => {
        await d.execute('s5', db, ['create table if not exists imp_test (a int, b varchar(50))'], 1);
        async function* gen() {
          for (let k = 0; k < 3; k++) yield Array.from({ length: 1000 }, (_, i) => [String(k * 1000 + i), `ligne ${i}`]);
        }
        const n = await d.bulkInsert(db, schema, 'imp_test', ['a', 'b'], gen(), { truncate: true });
        assert.equal(n, 3000);
        assert.equal(await d.count(db, schema, 'imp_test'), 3000);
        await d.execute('s5', db, ['drop table imp_test'], 1);
        await d.closeSession('s5');
      });
      await t('liste des processus', async () => {
        const p = await d.processes();
        assert.ok(p.length >= 1);
      });
      await t('sauvegarde puis restauration (outils natifs)', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ksdb-'));
        const file = path.join(tmp, cfg.kind === 'postgres' ? 'b.dump' : 'b.sql');
        const logs: string[] = [];
        const sink = { log: (m: string) => logs.push(m), progress: () => {} };
        const ep = { host: cfg.host, port: cfg.port };
        await dump({ child: null, cancelled: false }, cfg, ep, {
          connectionId: cfg.id, database: db, filePath: file, format: 'custom', content: 'all',
        }, settings, sink);
        assert.ok(fs.statSync(file).size > 10000);
        const target = 'boutique_restore';
        await d.execute('s6', '', [`drop database if exists ${target}`, `create database ${target}`], 1);
        await d.closeSession('s6');
        await restore({ child: null, cancelled: false }, cfg, ep, {
          connectionId: cfg.id, database: target, filePath: file, noOwner: true, jobs: 2,
        }, settings, sink);
        const ts = cfg.kind === 'postgres' ? 'public' : target;
        assert.equal(await d.count(target, ts, 'clients'), 5000);
        const cs = cfg.kind === 'postgres' ? 'ventes' : target;
        assert.equal(await d.count(target, cs, 'commandes'), 20000);
        await d.close();
        await d.execute('s7', '', [`drop database ${target}`], 1);
        await d.closeSession('s7');
      });
    } finally {
      await d.close();
      dispose();
    }
  }

  console.log('\nTunnel SSH');
  if (env.KSDB_SSH_PORT) {
    await t('PG via tunnel SSH (mot de passe)', async () => {
      const info = await ConnectionManager.test({
        ...pgCfg,
        ssh: { enabled: true, host: '127.0.0.1', port: Number(env.KSDB_SSH_PORT), user: 'tunneluser', auth: 'password', password: 'tunnelpass' },
      });
      assert.match(info.version, /PostgreSQL/);
    });
    await t('MariaDB via tunnel SSH (clé + passphrase)', async () => {
      const info = await ConnectionManager.test({
        ...myCfg,
        ssh: { enabled: true, host: '127.0.0.1', port: Number(env.KSDB_SSH_PORT), user: 'tunneluser', auth: 'key', keyPath: env.KSDB_SSH_KEY, passphrase: 'phrase' },
      });
      assert.match(info.version, /MariaDB/);
    });
    await t('mauvais mot de passe SSH => erreur claire', async () => {
      await assert.rejects(
        ConnectionManager.test({ ...pgCfg, ssh: { enabled: true, host: '127.0.0.1', port: Number(env.KSDB_SSH_PORT), user: 'tunneluser', auth: 'password', password: 'faux' } }),
        /Tunnel SSH/,
      );
    });
  } else console.log('  (ignoré : KSDB_SSH_PORT non défini)');

  console.log('\nOutils détectés');
  for (const s of toolStatus(settings)) console.log(`  ${s.name.padEnd(11)} ${s.path ?? '—'}  ${s.version ?? ''}`);

  console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests passent');
  process.exit(failed ? 1 : 0);
}

main();
