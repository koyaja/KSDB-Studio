// Tests des plans d'exécution : analyse des formats et diagnostics sur de vrais serveurs.
import assert from 'node:assert/strict';
import type { ConnectionConfig } from '../shared/types';
import { createDriver } from '../main/connections';
import type { Driver } from '../main/drivers/base';
import { runExplain } from '../main/explain';
import { conditionColumns, isWriteStatement, parseMysqlJson, parseMysqlTree, parsePlan, Plan, PlanNode, walk } from '../shared/explain';
import { splitSql } from '../shared/sqlsplit';

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
async function run(d: Driver, db: string, sql: string) {
  const r = await d.execute('setup', db, splitSql(sql, d.kind).map((s) => s.text), 1000);
  const err = r.find((x) => x.error);
  if (err) throw new Error(`${err.error}\n--- ${err.statement}`);
  return r;
}
const nodes = (p: Plan) => {
  const out: PlanNode[] = [];
  walk(p.root, (n) => out.push(n));
  return out;
};
async function plan(d: Driver, db: string, sql: string, analyze: boolean) {
  const o = await runExplain(d, 'tab', db, sql, analyze);
  return { o, p: parsePlan(o.format, o.engine, o.output) };
}

const MYSQL8_TREE = `-> Limit: 5 row(s)  (actual time=52.1..52.1 rows=5 loops=1)
    -> Sort: count(0) DESC, limit input to 5 row(s) per chunk  (actual time=52.1..52.1 rows=5 loops=1)
        -> Table scan on <temporary>  (actual time=49.9..50.6 rows=5000 loops=1)
            -> Aggregate using temporary table  (actual time=49.9..49.9 rows=5000 loops=1)
                -> Nested loop inner join  (cost=9512 rows=19808) (actual time=0.09..34.5 rows=19920 loops=1)
                    -> Table scan on c  (cost=503 rows=4980) (actual time=0.05..1.9 rows=5000 loops=1)
                    -> Filter: (o.montant > 100.00)  (cost=1.41 rows=3.98) (actual time=0.004..0.006 rows=3.98 loops=5000)
                        -> Index lookup on o using idx_client (client_id=c.id)  (cost=1.41 rows=4) (actual time=0.004..0.005 rows=4 loops=5000)`;

const MYSQL8_JSON = JSON.stringify({
  query_block: {
    select_id: 1,
    cost_info: { query_cost: '2041.25' },
    ordering_operation: {
      using_filesort: true,
      grouping_operation: {
        using_temporary_table: true,
        nested_loop: [
          { table: { table_name: 'c', access_type: 'ALL', possible_keys: ['PRIMARY'], rows_examined_per_scan: 4980, filtered: '100.00', cost_info: { read_cost: '5.25', prefix_cost: '503.25' } } },
          {
            table: {
              table_name: 'o',
              access_type: 'ref',
              possible_keys: ['idx_client'],
              key: 'idx_client',
              ref: ['boutique.c.id'],
              rows_examined_per_scan: 4,
              filtered: '33.33',
              attached_condition: '(`boutique`.`o`.`montant` > 100.00)',
              cost_info: { read_cost: '4980.00', prefix_cost: '2041.25' },
            },
          },
        ],
      },
    },
  },
});

async function main() {
  console.log('Formats');
  await t('MySQL 8 EXPLAIN ANALYZE (TREE)', () => {
    const p = parseMysqlTree(MYSQL8_TREE);
    assert.ok(p.analyzed);
    assert.equal(p.root.op, 'Limit');
    const all = nodes(p);
    assert.equal(all.length, 8);
    const scan = all.find((n) => n.op === 'Table scan' && n.relation === 'c')!;
    assert.equal(scan.actRows, 5000);
    const look = all.find((n) => n.op === 'Index lookup')!;
    assert.equal(look.index, 'idx_client');
    assert.equal(look.loops, 5000);
    assert.equal(Math.round(look.totalMs!), 25);
    assert.ok(Math.abs(p.total - 52.1) < 0.01);
  });
  await t('MySQL 8 EXPLAIN FORMAT=JSON', () => {
    const p = parseMysqlJson(MYSQL8_JSON, 'mysql');
    assert.ok(!p.analyzed);
    assert.equal(p.metric, 'cost');
    const titles = nodes(p).map((n) => n.title);
    assert.deepEqual(titles, ['Requête #1', 'Tri (filesort)', 'Regroupement (table temporaire)', 'Boucle imbriquée', 'Parcours complet', 'Recherche par index']);
    assert.equal(p.total, 2041.25);
  });
  await t('colonnes d’une condition, instructions d’écriture', () => {
    assert.deepEqual(conditionColumns('((v = 42) AND (lower(nom) ~~ \'a%\'::text))'), ['v']);
    assert.deepEqual(conditionColumns('(t.client_id = 3) OR (statut IS NULL)'), ['client_id', 'statut']);
    assert.deepEqual(conditionColumns("((o.statut)::text = 'payee'::text)"), ['statut']);
    assert.deepEqual(conditionColumns('(`boutique`.`o`.`montant` > 100.00)'), ['montant']);
    assert.ok(isWriteStatement('  -- x\n delete from t'));
    assert.ok(isWriteStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'));
    assert.ok(!isWriteStatement('select * from t'));
  });

  const { driver: pg, dispose: d1 } = createDriver(pgCfg);
  const { driver: my, dispose: d2 } = createDriver(myCfg);
  try {
    console.log('\nPostgreSQL');
    await run(
      pg,
      'boutique',
      `drop table if exists public.xp_mesures;
       create table public.xp_mesures(id serial primary key, capteur int, v int, note text);
       insert into public.xp_mesures(capteur, v, note) select g % 50, g % 1000, md5(g::text) from generate_series(1, 60000) g;
       analyze public.xp_mesures`,
    );
    await t('EXPLAIN ANALYZE : parcours complet repéré, index conseillé sur la colonne filtrée', async () => {
      const { p } = await plan(pg, 'boutique', 'select * from xp_mesures where v = 42', true);
      assert.ok(p.analyzed && p.metric === 'time' && p.total > 0);
      assert.ok(p.planningMs !== undefined && p.executionMs !== undefined);
      const scan = nodes(p).find((n) => n.op === 'Seq Scan')!;
      assert.equal(scan.relation, 'public.xp_mesures');
      assert.equal(scan.actRows, 60);
      assert.ok(scan.removed! > 50000);
      assert.ok(p.warnings.some((w) => /index sur public\.xp_mesures \(v\)/.test(w.text)), JSON.stringify(p.warnings));
    });
    await t('après CREATE INDEX : plus d’alerte, parcours d’index', async () => {
      await run(pg, 'boutique', 'create index xp_mesures_v on public.xp_mesures(v)');
      const { p } = await plan(pg, 'boutique', 'select * from xp_mesures where v = 42', true);
      assert.ok(nodes(p).some((n) => n.index === 'xp_mesures_v'));
      assert.ok(!p.warnings.some((w) => /Parcours complet/.test(w.text)));
    });
    await t('EXPLAIN sans ANALYZE : coûts, rien d’exécuté', async () => {
      const { p } = await plan(pg, 'boutique', 'select capteur, count(*) from xp_mesures group by capteur order by 2 desc', false);
      assert.ok(!p.analyzed && p.metric === 'cost' && p.total > 0);
      const sum = nodes(p).reduce((a, n) => a + (n.selfCost ?? 0), 0);
      assert.ok(Math.abs(sum - p.total) < 0.01 * p.total + 0.01, `${sum} vs ${p.total}`);
    });
    await t('ANALYZE d’un DELETE : exécuté puis annulé', async () => {
      const { o, p } = await plan(pg, 'boutique', 'delete from xp_mesures where capteur = 3', true);
      assert.ok(o.rolledBack);
      assert.ok(nodes(p).some((n) => n.title === 'Delete'));
      const [r] = await run(pg, 'boutique', 'select count(*) from public.xp_mesures');
      assert.equal(Number(r.rows[0][0]), 60000);
    });
    await t('estimation fausse signalée', async () => {
      await run(pg, 'boutique', "update public.xp_mesures set note = 'x' where id <= 30000");
      // statistiques périmées : note = 'x' estimé rare
      const { p } = await plan(pg, 'boutique', "select * from xp_mesures where note = 'x'", true);
      assert.ok(p.warnings.some((w) => /Estimation trop basse/.test(w.text) && /ANALYZE public\.xp_mesures/.test(w.text)), JSON.stringify(p.warnings));
    });
    await t('search_path de l’onglet respecté', async () => {
      await run(pg, 'boutique', 'create schema if not exists xp; create table if not exists xp.seule(id int)');
      await pg.execute('tab', 'boutique', ['SET search_path TO xp, public'], 10);
      const { p } = await plan(pg, 'boutique', 'select * from seule', false);
      assert.equal(nodes(p)[0].relation, 'xp.seule');
      await pg.closeSession('tab');
    });

    console.log('\nMariaDB');
    await run(
      my,
      '',
      `create database if not exists xp_test;
       drop table if exists xp_test.mesures;
       create table xp_test.mesures(id int auto_increment primary key, capteur int, v int, note varchar(40)) engine=InnoDB`,
    );
    await run(
      my,
      'xp_test',
      `insert into xp_test.mesures(capteur, v, note) select seq % 50, seq % 1000, md5(seq) from seq_1_to_60000;
       analyze table xp_test.mesures`,
    );
    await t('ANALYZE FORMAT=JSON : parcours complet + index conseillé', async () => {
      const { p } = await plan(my, 'xp_test', 'select * from mesures where v = 42', true);
      assert.equal(p.engine, 'mariadb');
      assert.ok(p.analyzed && p.metric === 'time');
      const scan = nodes(p).find((n) => n.op === 'ALL')!;
      assert.equal(scan.relation, 'mesures');
      assert.equal(scan.actRows, 60);
      assert.equal(scan.removed, 59940);
      assert.ok(p.warnings.some((w) => /index sur mesures \(v\)/.test(w.text)), JSON.stringify(p.warnings));
    });
    await t('jointure + tri + regroupement', async () => {
      const { p } = await plan(my, 'boutique', 'select c.nom, count(*) from clients c join commandes o on o.client_id = c.id where o.montant > 100 group by c.nom order by 2 desc limit 5', true);
      const titles = nodes(p).map((n) => n.title);
      assert.ok(titles.includes('Tri') && titles.includes('Table temporaire') && titles.includes('Boucle imbriquée'), titles.join(' | '));
      assert.ok(nodes(p).some((n) => n.index === 'idx_client'));
    });
    await t('ANALYZE d’un DELETE : annulé', async () => {
      const { o } = await plan(my, 'xp_test', 'delete from mesures where capteur = 3', true);
      assert.ok(o.rolledBack);
      const [r] = await run(my, 'xp_test', 'select count(*) from mesures');
      assert.equal(Number(r.rows[0][0]), 60000);
    });
    await t('EXPLAIN simple : coûts ou lignes estimées', async () => {
      const { p } = await plan(my, 'xp_test', 'select * from mesures where v = 42', false);
      assert.ok(!p.analyzed);
      assert.equal(p.metric, 'rows');
      assert.ok(p.total > 50000);
      const j = await plan(my, 'boutique', 'select c.nom, count(*) from clients c join commandes o on o.client_id = c.id group by c.nom', false);
      const look = nodes(j.p).find((n) => n.index === 'idx_client')!;
      // examinée une fois par client : ≈ 4 980 × lignes par client
      assert.ok(look.selfCost! > 4000, String(look.selfCost));
    });
  } finally {
    await run(pg, 'boutique', 'drop table if exists public.xp_mesures; drop schema if exists xp cascade').catch(() => {});
    await run(my, '', 'drop database if exists xp_test').catch(() => {});
    await pg.close();
    await my.close();
    d1();
    d2();
  }
  console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests des plans passent');
  process.exit(failed ? 1 : 0);
}

main();
