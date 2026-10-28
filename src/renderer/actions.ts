// Actions d'administration déclenchées depuis l'arbre ou les onglets.
import type { DbKind } from '../shared/types';
import { api } from './api';
import { bumpTree, confirmDialog, connectionById, toast, uid } from './state';

export const quoteIdent = (kind: DbKind, n: string) =>
  kind === 'mysql' ? '`' + n.replace(/`/g, '``') + '`' : '"' + n.replace(/"/g, '""') + '"';

export const qualified = (kind: DbKind, db: string, schema: string, name: string) =>
  kind === 'mysql' ? `${quoteIdent(kind, db)}.${quoteIdent(kind, name)}` : `${quoteIdent(kind, schema)}.${quoteIdent(kind, name)}`;

/** Exécute un script court hors onglet ; renvoie true si tout a réussi. */
export async function runAdmin(
  connectionId: string,
  db: string,
  sql: string,
  opts: { confirm?: string; success?: string; refresh?: string[] } = {},
): Promise<boolean> {
  if (opts.confirm) {
    const ok = await confirmDialog(opts.confirm, sql, { danger: true, confirmLabel: 'Exécuter' });
    if (!ok) return false;
  }
  const sid = 'admin-' + uid();
  try {
    const res = await api.execute(connectionId, sid, db, sql);
    const err = res.find((r) => r.error);
    if (err) {
      toast(err.error!, 'error');
      return false;
    }
    if (opts.success) toast(opts.success, 'success');
    for (const k of opts.refresh ?? []) bumpTree(k);
    return true;
  } catch (e) {
    toast((e as Error).message, 'error');
    return false;
  } finally {
    api.closeSession(connectionId, sid).catch(() => {});
  }
}

export function kindOf(connectionId: string | null | undefined): DbKind {
  return connectionById(connectionId)?.kind ?? 'postgres';
}

export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
  toast('Copié dans le presse-papiers');
}
