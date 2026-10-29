// Exécution d'EXPLAIN dans une session dédiée (ANALYZE dans une transaction annulée).
import type { Driver } from './drivers/base';
import { explainSql, isWriteStatement } from '../shared/explain';
import { mysqlFlavor } from './roles';

export interface ExplainOutput {
  engine: 'postgres' | 'mysql' | 'mariadb';
  format: 'pg-json' | 'my-json' | 'my-tree';
  output: string;
  durationMs: number;
  /** ANALYZE d'une instruction d'écriture : exécutée puis annulée */
  rolledBack: boolean;
}

async function one(d: Driver, sid: string, db: string, sql: string): Promise<string> {
  const [r] = await d.execute(sid, db, [sql], 100000);
  if (r.error) throw new Error(r.error);
  if (!r.rows.length) return '';
  // EXPLAIN FORMAT=TREE / texte : une ligne par nœud possible
  return r.rows.map((row) => String(row[0] ?? '')).join('\n');
}

export async function runExplain(d: Driver, tabSession: string, db: string, sql: string, analyze: boolean): Promise<ExplainOutput> {
  const engine = await mysqlFlavor(d);
  const q = explainSql(engine, sql, analyze);
  const sid = `explain-${tabSession}`;
  const write = isWriteStatement(sql);
  const t0 = performance.now();
  try {
    if (engine === 'postgres') {
      // même search_path que l'onglet de requête
      const sp = await one(d, tabSession, db, 'SHOW search_path').catch(() => '');
      if (sp) await one(d, sid, db, `SET search_path TO ${sp}`).catch(() => {});
    }
    if (analyze) await one(d, sid, db, engine === 'postgres' ? 'BEGIN' : 'START TRANSACTION');
    let output: string;
    try {
      output = await one(d, sid, db, q.sql);
    } finally {
      if (analyze) await one(d, sid, db, 'ROLLBACK').catch(() => {});
    }
    return { engine, format: q.format, output, durationMs: performance.now() - t0, rolledBack: analyze && write };
  } finally {
    await d.closeSession(sid).catch(() => {});
  }
}
