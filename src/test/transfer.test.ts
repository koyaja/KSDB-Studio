// Tests du transfert de données sur de vrais serveurs PostgreSQL et MariaDB.
import assert from 'node:assert/strict';
import { splitSql } from '../shared/sqlsplit';
import type { ConnectionConfig, TransferEvent, TransferOptions } from '../shared/types';
import { createDriver } from '../main/connections';
import type { Driver } from '../main/drivers/base';
import { convertValue, fkOrder, matchColumns, runTransfer } from '../main/transfer';

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
    console.log(`  ✗ ${name}\n    ${(e as Error).stack?.split('\n').slice(0, 5).join('\n    ')}`);
  }
}

async function run(d: Driver, db: string, sql: string) {
  const r = await d.execute('setup', db, splitSql(sql, d.kind).map((s) => s.text), 1000);
  const err = r.find((x) => x.error);
  if (err) throw new Error(`${err.error}\n--- ${err.statement}`);
  return r;
}
async function one(d: Driver, db: string, sql: string) {
  const r = await run(d, db, sql);
  return r[r.length - 1].rows[0]?.[0];
}

const base = (src: TransferOptions['source'], tgt: TransferOptions['target']): TransferOptions => ({
  source: src,
  target: tgt,
  tables: [],
  structure: 'recreate',
  data: true,
  before: 'truncate',
  onConflict: 'error',
  resetSequences: true,
  disableChecks: false,
  continueOnError: true,
  batchSize: 700,
});

async function go(o: TransferOptions, src: Driver, tgt: Driver) {
  const events: TransferEvent[] = [];
  const r = await runTransfer(o, { src, tgt, id: Math.random().toString(36).slice(2), cancelled: () => false, emit: (e) => events.push(e) });
  const errs = events.filter((e) => e.type === 'table' && e.state === 'error');
  if (errs.length && process.env.DBG) console.log(JSON.stringify(errs, null, 1));
  return { ...r, events, errs };
}

const PG_SETUP = `
drop schema if exists xfer_src cascade; drop schema if exists xfer_dst cascade;
create schema xfer_src; create schema xfer_dst;
set search_path to xfer_src;
create table categories(id serial primary key, nom text not null, parent_id int references categories(id));
create table produits(id bigint generated always as identity primary key, sku text unique not null, categorie_id int references categories(id),
  prix numeric(12,2), ttc numeric(12,2) generated always as (prix * 1.18) stored);
create table lignes(produit_id bigint references produits(id), n int, primary key (produit_id, n));
create table fichiers(id serial primary key, contenu bytea, meta jsonb, liste jsonb, tags text[], cree timestamptz default now());
insert into categories(nom) select 'cat ' || g from generate_series(1, 50) g;
update categories set parent_id = id - 1 where id > 1;
insert into produits(sku, categorie_id, prix) select 'P' || g, (g % 50) + 1, g * 1.5 from generate_series(1, 3000) g;
insert into lignes select (g % 3000) + 1, g from generate_series(1, 5000) g;
insert into fichiers(contenu, meta, liste, tags) values
  ((select string_agg(lpad(to_hex(i), 2, '0'), '')::text from generate_series(0, 255) i)::bytea, '{"a": 1, "b": [1, 2]}', '[1, "deux", null]', array['x', 'y,z', 'é']),
  (decode(repeat('00ff', 5000), 'hex'), null, '[]', '{}');
`;

async function main() {
  console.log('Fonctions');
  await t('ordre des tables selon les clés étrangères (cycle toléré)', () => {
    const mk = (name: string, refs: string[]) => ({ name, columns: [], pk: null, indexes: [], comment: null, fks: refs.map((r) => ({ name: r, columns: [], refTable: r, refColumns: [], onUpdate: '', onDelete: '', refSchema: null })) });
    const order = fkOrder([mk('lignes', ['produits', 'commandes']), mk('produits', ['categories']), mk('categories', ['categories']), mk('commandes', ['clients']), mk('clients', [])]).map((x) => x.name);
    assert.ok(order.indexOf('categories') < order.indexOf('produits'));
    assert.ok(order.indexOf('produits') < order.indexOf('lignes'));
    assert.ok(order.indexOf('clients') < order.indexOf('commandes'));
  });
  await t('correspondance des colonnes', () => {
    const c = (name: string, extra: object = {}) => ({ name, type: 'int', nullable: true, default: null, identity: '', comment: null, ...extra });
    const m = matchColumns([c('id'), c('Nom'), c('calc', { generated: true }), c('ancien')], [c('id'), c('nom'), c('obligatoire', { nullable: false })]);
    assert.deepEqual(m.pairs.map((p) => `${p.s.name}>${p.t.name}`), ['id>id', 'Nom>nom']);
    assert.deepEqual(m.missing, ['ancien']);
    assert.deepEqual(m.required, ['obligatoire']);
  });
  await t('conversion des valeurs', () => {
    assert.equal(convertValue({ a: 1 }, 'postgres', 'jsonb'), '{"a":1}');
    assert.equal(convertValue([1, 2], 'postgres', 'jsonb'), '[1,2]');
    assert.deepEqual(convertValue(['a', 'b'], 'postgres', 'text[]'), ['a', 'b']);
    assert.equal(convertValue({ a: 1 }, 'mysql', 'json'), '{"a":1}');
    assert.ok(Buffer.isBuffer(convertValue(Buffer.from([0, 255]), 'mysql', 'blob')));
  });

  const { driver: pg, dispose: d1 } = createDriver(pgCfg);
  const { driver: my, dispose: d2 } = createDriver(myCfg);
  try {
    await run(pg, 'boutique', PG_SETUP);
    const S = { connectionId: 'pg', database: 'boutique', schema: 'xfer_src' };
    const D = { connectionId: 'pg', database: 'boutique', schema: 'xfer_dst' };
    const all = [{ name: 'categories' }, { name: 'produits' }, { name: 'lignes' }, { name: 'fichiers' }];

    console.log('\nPostgreSQL → PostgreSQL');
    await t('création des tables + copie complète', async () => {
      const r = await go({ ...base(S, D), tables: [...all].reverse() }, pg, pg);
      assert.deepEqual(r.errs, []);
      assert.equal(r.rows, 50 + 3000 + 5000 + 2);
      for (const [tb, n] of [['categories', 50], ['produits', 3000], ['lignes', 5000], ['fichiers', 2]] as const)
        assert.equal(Number(await one(pg, 'boutique', `select count(*) from xfer_dst.${tb}`)), n, tb);
    });
    await t('fidélité : binaire, JSON, tableaux, colonne calculée', async () => {
      const same = await one(
        pg,
        'boutique',
        `select bool_and(s.contenu = d.contenu and s.meta is not distinct from d.meta and s.liste = d.liste and s.tags = d.tags and s.cree = d.cree)
         from xfer_src.fichiers s join xfer_dst.fichiers d using (id)`,
      );
      assert.equal(same, true);
      assert.equal(String(await one(pg, 'boutique', `select ttc from xfer_dst.produits where id = 10`)), '17.70');
    });
    await t('clés étrangères recréées et séquences recalées', async () => {
      const snap = await pg.snapshot('boutique', 'xfer_dst');
      assert.equal(snap.tables.find((x) => x.name === 'lignes')!.fks.length, 1);
      assert.equal(snap.tables.find((x) => x.name === 'categories')!.fks.length, 1);
      await run(pg, 'boutique', `insert into xfer_dst.categories(nom) values ('nouvelle'); insert into xfer_dst.produits(sku, prix) values ('NEW', 1)`);
      assert.equal(Number(await one(pg, 'boutique', `select max(id) from xfer_dst.categories`)), 51);
    });
    await t('ajout sur tables existantes en ignorant les doublons', async () => {
      const r = await go({ ...base(S, D), tables: all, structure: 'existing', before: 'append', onConflict: 'ignore' }, pg, pg);
      assert.deepEqual(r.errs, []);
      assert.equal(Number(await one(pg, 'boutique', `select count(*) from xfer_dst.lignes`)), 5000);
    });
    await t('doublons sans « ignorer » : erreur claire, table annulée, les autres continuent', async () => {
      const r = await go({ ...base(S, D), tables: [{ name: 'lignes' }, { name: 'fichiers' }], structure: 'existing', before: 'append' }, pg, pg);
      assert.equal(r.errs.length, 2);
      assert.match(JSON.stringify(r.errs[0]), /duplicate key|clé dupliquée|unique/i);
      assert.equal(Number(await one(pg, 'boutique', `select count(*) from xfer_dst.lignes`)), 5000);
    });
    await t('filtre WHERE', async () => {
      await assert.rejects(
        go({ ...base(S, D), tables: [{ name: 'categories' }, { name: 'produits', where: 'id <= 25' }], structure: 'existing' }, pg, pg),
        /Vidage impossible.*\n.*\n→ Ajoute/s,
      );
      const r = await go(
        { ...base(S, D), tables: [{ name: 'categories' }, { name: 'produits', where: 'id <= 25' }, { name: 'lignes', where: 'produit_id <= 25' }], structure: 'existing' },
        pg,
        pg,
      );
      assert.equal(Number(await one(pg, 'boutique', `select count(*) from xfer_dst.produits`)), 25);
      assert.deepEqual(r.errs, []);
    });

    console.log('\nMariaDB → MariaDB');
    await run(my, '', `drop database if exists xfer_copy; create database xfer_copy character set utf8mb4`);
    await t('copie de boutique vers une nouvelle base (structure + données)', async () => {
      const r = await go(
        { ...base({ connectionId: 'my', database: 'boutique', schema: 'boutique' }, { connectionId: 'my', database: 'xfer_copy', schema: 'xfer_copy' }), tables: [{ name: 'commandes' }, { name: 'clients' }, { name: 'journal' }] },
        my,
        my,
      );
      assert.deepEqual(r.errs, []);
      assert.equal(Number(await one(my, '', `select count(*) from xfer_copy.commandes`)), 20000);
      assert.equal(Number(await one(my, '', `select count(*) from xfer_copy.clients`)), Number(await one(my, '', `select count(*) from boutique.clients`)));
      const snap = await my.snapshot('xfer_copy', 'xfer_copy');
      assert.equal(snap.tables.find((x) => x.name === 'commandes')!.fks.length, 1);
    });

    console.log('\nPostgreSQL ↔ MariaDB (tables existantes)');
    await run(
      my,
      'xfer_copy',
      `create table pg_clients(id int primary key, nom varchar(100), email varchar(150), solde decimal(12,2), actif tinyint(1), cree_le datetime(6), meta json, inconnue int null)`,
    );
    await t('PostgreSQL → MariaDB : types convertis (booléen, JSON, date avec fuseau)', async () => {
      const r = await go(
        { ...base({ connectionId: 'pg', database: 'boutique', schema: 'public' }, { connectionId: 'my', database: 'xfer_copy', schema: 'xfer_copy' }), tables: [{ name: 'clients' }], structure: 'existing' },
        pg,
        my,
      );
      assert.deepEqual(r.errs, []);
      const n = Number(await one(pg, 'boutique', 'select count(*) from public.clients'));
      assert.equal(Number(await one(my, 'xfer_copy', 'select count(*) from pg_clients')), 0, 'table pg_clients non visée');
      assert.ok(n > 0);
    });
    await run(my, 'xfer_copy', `drop table pg_clients; create table clients_pg(id int primary key)`);
    await run(my, 'xfer_copy', `rename table clients to clients_my, clients_pg to clients`);
    await run(my, 'xfer_copy', `drop table clients; create table clients(id int primary key, nom varchar(100), email varchar(150), solde decimal(12,2), actif tinyint(1), cree_le datetime(6), meta json, inconnue int null)`);
    await t('PostgreSQL → MariaDB : copie réelle', async () => {
      const r = await go(
        { ...base({ connectionId: 'pg', database: 'boutique', schema: 'public' }, { connectionId: 'my', database: 'xfer_copy', schema: 'xfer_copy' }), tables: [{ name: 'clients' }], structure: 'existing' },
        pg,
        my,
      );
      assert.deepEqual(r.errs, []);
      const n = Number(await one(pg, 'boutique', 'select count(*) from public.clients'));
      assert.equal(Number(await one(my, 'xfer_copy', 'select count(*) from clients')), n);
      assert.equal(String(await one(my, 'xfer_copy', `select json_extract(meta, '$.n') from clients where id = 3`)), '3');
      assert.equal(Number(await one(my, 'xfer_copy', `select actif from clients where id = 3`)), 1);
      const pgTs = String(await one(pg, 'boutique', `select to_char(cree_le, 'YYYY-MM-DD HH24:MI') from public.clients where id = 3`));
      const myTs = String(await one(my, 'xfer_copy', `select date_format(cree_le, '%Y-%m-%d %H:%i') from clients where id = 3`));
      assert.equal(myTs, pgTs);
    });
    await t('MariaDB → PostgreSQL : 20 000 lignes', async () => {
      await run(pg, 'boutique', `create table xfer_dst.commandes(id bigint primary key, client_id int, montant numeric(10,2), statut text)`);
      const r = await go(
        { ...base({ connectionId: 'my', database: 'boutique', schema: 'boutique' }, D), tables: [{ name: 'commandes' }], structure: 'existing' },
        my,
        pg,
      );
      assert.deepEqual(r.errs, []);
      assert.equal(Number(await one(pg, 'boutique', 'select count(*) from xfer_dst.commandes')), 20000);
      assert.equal(String(await one(pg, 'boutique', 'select sum(montant) from xfer_dst.commandes')), String(await one(my, '', 'select sum(montant) from boutique.commandes')));
    });
    await t('création refusée entre moteurs différents', async () => {
      await assert.rejects(go({ ...base(S, { connectionId: 'my', database: 'xfer_copy', schema: 'xfer_copy' }), tables: all }, pg, my), /même type/);
    });
  } finally {
    await run(pg, 'boutique', 'drop schema if exists xfer_src cascade; drop schema if exists xfer_dst cascade').catch(() => {});
    await run(my, '', 'drop database if exists xfer_copy').catch(() => {});
    await pg.close();
    await my.close();
    d1();
    d2();
  }
  console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests de transfert passent');
  process.exit(failed ? 1 : 0);
}

main();
