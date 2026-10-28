// Transfert de tables et de données entre deux bases (mêmes serveurs ou serveurs différents).
import { diffSchemas, qid, SchemaSnapshot, SnapColumn, SnapTable } from '../shared/schemadiff';
import type { TransferEvent, TransferOptions } from '../shared/types';
import type { Driver } from './drivers/base';
import { friendlyError } from './drivers/base';

export interface TransferContext {
  src: Driver;
  tgt: Driver;
  emit: (ev: TransferEvent) => void;
  cancelled: () => boolean;
  /** identifiant unique (sessions SQL) */
  id: string;
}

/** Tables triées pour que les tables référencées passent avant celles qui les référencent. */
export function fkOrder(tables: SnapTable[]): SnapTable[] {
  const by = new Map(tables.map((t) => [t.name, t]));
  const out: SnapTable[] = [];
  const state = new Map<string, 1 | 2>();
  const visit = (t: SnapTable) => {
    if (state.get(t.name) === 2) return;
    if (state.get(t.name) === 1) return; // cycle : on le casse
    state.set(t.name, 1);
    for (const f of t.fks) {
      const dep = !f.refSchema ? by.get(f.refTable) : undefined;
      if (dep && dep !== t) visit(dep);
    }
    state.set(t.name, 2);
    out.push(t);
  };
  for (const t of tables) visit(t);
  return out;
}

/** Associe les colonnes source aux colonnes cible (nom exact, puis sans tenir compte de la casse). */
export function matchColumns(src: SnapColumn[], tgt: SnapColumn[]) {
  const exact = new Map(tgt.map((c) => [c.name, c]));
  const lower = new Map(tgt.map((c) => [c.name.toLowerCase(), c]));
  const pairs: { s: SnapColumn; t: SnapColumn }[] = [];
  const missing: string[] = [];
  for (const s of src) {
    if (s.generated) continue;
    const t = exact.get(s.name) ?? lower.get(s.name.toLowerCase());
    if (!t || t.generated) missing.push(s.name);
    else pairs.push({ s, t });
  }
  const used = new Set(pairs.map((p) => p.t.name));
  const required = tgt.filter((c) => !used.has(c.name) && !c.nullable && c.default === null && !c.identity && !c.generated && !/auto_increment/i.test(c.def ?? '') && !/\bDEFAULT\b/i.test(c.def ?? ''));
  return { pairs, missing, required: required.map((c) => c.name) };
}

/** Adapte une valeur lue à la colonne cible (JSON, tableaux PG, binaire). */
export function convertValue(v: unknown, targetKind: 'postgres' | 'mysql', targetType: string): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (targetKind === 'postgres') {
      if (/\[\]$/.test(targetType) && Array.isArray(v)) return v; // tableau PG
      return JSON.stringify(v);
    }
    return JSON.stringify(v);
  }
  if (targetKind === 'postgres' && /^jsonb?$/.test(targetType) && typeof v !== 'string') return JSON.stringify(v);
  // horodatage PostgreSQL avec fuseau (« 2026-10-27 22:33:38.17+01 ») vers DATETIME / TIMESTAMP MySQL :
  // converti en instant puis écrit à l'heure locale de la connexion
  if (targetKind === 'mysql' && typeof v === 'string' && /^(datetime|timestamp)/.test(targetType)) {
    const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?(Z|[+-]\d\d(?::?\d\d)?)$/.exec(v);
    if (m) {
      const frac = (m[3] ?? '').slice(0, 4);
      const off = m[4] === 'Z' ? 'Z' : m[4].length === 3 ? `${m[4]}:00` : m[4].replace(/^([+-]\d\d)(\d\d)$/, '$1:$2');
      const d = new Date(`${m[1]}T${m[2]}${frac}${off}`);
      if (!isNaN(d.getTime())) return d;
    }
  }
  return v;
}

async function run(d: Driver, sid: string, db: string, stmts: string[]) {
  if (!stmts.length) return;
  const res = await d.execute(sid, db, stmts, 1);
  const err = res.find((r) => r.error);
  if (err) throw new Error(`${err.error}\n→ ${err.statement.slice(0, 400)}`);
}

export async function runTransfer(o: TransferOptions, ctx: TransferContext): Promise<{ rows: number; errors: number }> {
  const { src, tgt, emit } = ctx;
  const t0 = Date.now();
  const sid = `transfer-${ctx.id}`;
  const log = (message: string, level: 'info' | 'warn' | 'error' = 'info') => emit({ type: 'log', level, message });
  const sameKind = src.kind === tgt.kind;
  const T = o.target.schema;
  const qt = (name: string) => (tgt.kind === 'mysql' ? qid('mysql', name) : `${qid('postgres', T)}.${qid('postgres', name)}`);
  if (o.structure !== 'existing' && !sameKind)
    throw new Error('La création des tables n’est possible qu’entre deux serveurs du même type. Entre PostgreSQL et MySQL, crée d’abord les tables dans la cible puis choisis « Tables existantes ».');

  log('Lecture des structures source et cible…');
  const srcSnap = await src.snapshot(o.source.database, o.source.schema);
  let tgtSnap = await tgt.snapshot(o.target.database, T);
  const wanted = new Map(o.tables.map((t) => [t.name, t]));
  const selected = fkOrder(srcSnap.tables.filter((t) => wanted.has(t.name)));
  for (const t of o.tables) if (!srcSnap.tables.some((s) => s.name === t.name)) log(`Table source introuvable : ${t.name}`, 'warn');
  for (const t of selected) emit({ type: 'table', table: t.name, state: 'pending' });

  let errors = 0;
  let total = 0;
  const failed = new Set<string>();
  let addFk: string[] = [];

  try {
    // ---------- Structure ----------
    if (o.structure === 'recreate') {
      const existing = [...selected].reverse().filter((t) => tgtSnap.tables.some((x) => x.name === t.name));
      if (existing.length) {
        log(`Suppression de ${existing.length} table(s) dans la cible…`);
        const drops = existing.map((t) => `DROP TABLE IF EXISTS ${qt(t.name)}${tgt.kind === 'postgres' ? ' CASCADE' : ''}`);
        await run(tgt, sid, o.target.database, tgt.kind === 'mysql' ? ['SET FOREIGN_KEY_CHECKS = 0', ...drops, 'SET FOREIGN_KEY_CHECKS = 1'] : drops);
        tgtSnap = { ...tgtSnap, tables: tgtSnap.tables.filter((x) => !existing.some((e) => e.name === x.name)) };
      }
    }
    if (o.structure !== 'existing') {
      const srcSub: SchemaSnapshot = { ...srcSnap, tables: selected, objects: [] };
      const tgtSub: SchemaSnapshot = { ...tgtSnap, tables: tgtSnap.tables.filter((x) => wanted.has(x.name)), objects: [] };
      const toCreate = diffSchemas(srcSub, tgtSub, { targetSchema: T }).items.filter((i) => i.type === 'table' && i.status === 'added');
      // dans l'ordre des dépendances
      toCreate.sort((a, b) => selected.findIndex((t) => t.name === a.name) - selected.findIndex((t) => t.name === b.name));
      if (toCreate.length) {
        log(`Création de ${toCreate.length} table(s) : ${toCreate.map((i) => i.name).join(', ')}`);
        for (const item of toCreate) {
          try {
            const stmts = item.sql.createTable ?? [];
            await run(tgt, sid, o.target.database, tgt.kind === 'mysql' ? ['SET FOREIGN_KEY_CHECKS = 0', ...stmts, 'SET FOREIGN_KEY_CHECKS = 1'] : stmts);
            addFk.push(...(item.sql.addFk ?? []));
          } catch (e) {
            errors++;
            failed.add(item.name);
            emit({ type: 'table', table: item.name, state: 'error', error: `Création impossible : ${friendlyError(e)}` });
            if (!o.continueOnError) throw e;
          }
        }
        tgtSnap = await tgt.snapshot(o.target.database, T);
      }
    }

    // ---------- Données ----------
    if (o.data) {
      const present = selected.filter((t) => !failed.has(t.name) && tgtSnap.tables.some((x) => x.name === t.name));
      for (const t of selected)
        if (!failed.has(t.name) && !present.includes(t)) {
          failed.add(t.name);
          errors++;
          emit({ type: 'table', table: t.name, state: 'error', error: 'Table absente de la cible (choisis « Créer les tables manquantes »)' });
        }
      if (o.before === 'truncate' && present.length) {
        log(`Vidage de ${present.length} table(s) cible…`);
        if (tgt.kind === 'postgres') {
          try {
            await run(tgt, sid, o.target.database, [`TRUNCATE TABLE ${present.map((t) => qt(t.name)).join(', ')}`]);
          } catch (e) {
            const msg = friendlyError(e);
            if (/foreign key|clé étrangère/i.test(msg))
              throw new Error(
                `Vidage impossible : une autre table de la cible référence une des tables sélectionnées.\n${msg.split('\n')[0]}\n→ Ajoute aussi cette table à la sélection, ou choisis « Ajouter aux données existantes ».`,
              );
            throw e;
          }
        }
        else await run(tgt, sid, o.target.database, ['SET FOREIGN_KEY_CHECKS = 0', ...present.map((t) => `TRUNCATE TABLE ${qt(t.name)}`), 'SET FOREIGN_KEY_CHECKS = 1']);
      }

      for (const s of present) {
        if (ctx.cancelled()) throw new Error('Transfert arrêté');
        const target = tgtSnap.tables.find((x) => x.name === s.name)!;
        const { pairs, missing, required } = matchColumns(s.columns, target.columns);
        const notes: string[] = [];
        if (missing.length) notes.push(`colonnes ignorées (absentes de la cible) : ${missing.join(', ')}`);
        if (required.length) notes.push(`colonnes NOT NULL sans valeur : ${required.join(', ')}`);
        if (!pairs.length) {
          errors++;
          emit({ type: 'table', table: s.name, state: 'error', error: 'Aucune colonne commune' });
          continue;
        }
        emit({ type: 'table', table: s.name, state: 'running', rows: 0, note: notes.join(' · ') || undefined });
        const where = wanted.get(s.name)?.where?.trim();
        const srcQ = src.kind === 'mysql' ? `${qid('mysql', o.source.database)}.${qid('mysql', s.name)}` : `${qid('postgres', o.source.schema)}.${qid('postgres', s.name)}`;
        const sql = `SELECT ${pairs.map((p) => qid(src.kind, p.s.name)).join(', ')} FROM ${srcQ}${where ? ` WHERE ${where}` : ''}`;
        const types = pairs.map((p) => p.t.type.toLowerCase());
        const kind = tgt.kind;
        async function* rows() {
          for await (const b of src.iterate(o.source.database, sql, o.batchSize, true)) {
            if (ctx.cancelled()) throw new Error('Transfert arrêté');
            yield b.rows.map((r) => (r as unknown[]).map((v, i) => convertValue(v, kind, types[i])));
          }
        }
        try {
          const n = await tgt.bulkInsert(o.target.database, T, s.name, pairs.map((p) => p.t.name), rows(), {
            truncate: false,
            onConflict: o.onConflict,
            overriding: tgt.kind === 'postgres' && pairs.some((p) => p.t.identity === 'a'),
            disableChecks: tgt.kind === 'mysql' ? true : o.disableChecks,
            onProgress: (k) => emit({ type: 'table', table: s.name, state: 'running', rows: k }),
          });
          total += n;
          emit({ type: 'table', table: s.name, state: 'done', rows: n, note: notes.join(' · ') || undefined });
        } catch (e) {
          if (ctx.cancelled()) throw e;
          errors++;
          failed.add(s.name);
          emit({ type: 'table', table: s.name, state: 'error', error: friendlyError(e) + ' (table annulée, aucune ligne insérée)' });
          if (!o.continueOnError) throw new Error(`Arrêt sur erreur (${s.name})`);
        }
      }
    } else {
      for (const t of selected) if (!failed.has(t.name)) emit({ type: 'table', table: t.name, state: 'done', rows: 0, note: 'structure seule' });
    }

    // ---------- Clés étrangères des tables créées ----------
    if (addFk.length) {
      log(`Ajout de ${addFk.length} clé(s) étrangère(s)…`);
      for (const stmt of addFk) {
        try {
          await run(tgt, sid, o.target.database, [stmt]);
        } catch (e) {
          log(`Clé étrangère non créée : ${friendlyError(e).split('\n')[0]}`, 'warn');
        }
      }
      addFk = [];
    }

    // ---------- Séquences (PostgreSQL) ----------
    if (o.data && o.resetSequences && tgt.kind === 'postgres') {
      const stmts: string[] = [];
      for (const s of selected) {
        if (failed.has(s.name)) continue;
        const t = tgtSnap.tables.find((x) => x.name === s.name);
        for (const c of t?.columns ?? []) {
          if (!c.identity && !/^nextval\(/i.test(c.default ?? '')) continue;
          const tl = `'${qt(s.name).replace(/'/g, "''")}'`;
          const cl = `'${c.name.replace(/'/g, "''")}'`;
          stmts.push(
            `SELECT setval(x.s, (SELECT COALESCE(MAX(${qid('postgres', c.name)}), 0) + 1 FROM ${qt(s.name)}), false) FROM (SELECT pg_get_serial_sequence(${tl}, ${cl}) AS s) x WHERE x.s IS NOT NULL`,
          );
        }
      }
      if (stmts.length) {
        try {
          await run(tgt, sid, o.target.database, stmts);
          log(`${stmts.length} séquence(s) recalée(s) sur les valeurs copiées`);
        } catch (e) {
          log(`Séquences non recalées : ${friendlyError(e)}`, 'warn');
        }
      }
    }
  } finally {
    await tgt.closeSession(sid).catch(() => {});
    emit({ type: 'summary', tables: selected.length, rows: total, errors, seconds: Math.round((Date.now() - t0) / 1000) });
  }
  return { rows: total, errors };
}
