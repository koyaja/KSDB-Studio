import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  Copy,
  FileCode,
  GitCompareArrows,
  Loader2,
  Minus,
  Pencil,
  Play,
  Plus,
  Save,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { buildScript, diffSchemas, DiffItem, DiffResult } from '../../shared/schemadiff';
import { api } from '../api';
import { Modal } from '../components/ui';
import { bumpTree, confirmDialog, connectionById, ensureConnected, newQueryTab, Tab, toast, updateTab, useApp } from '../state';
import { invalidateCompletion } from './QueryTab';

type CTab = Extract<Tab, { kind: 'compare' }>;
export interface Side {
  connectionId: string | null;
  database: string;
  schema: string;
}

const TYPE_LABEL: Record<DiffItem['type'], string> = {
  table: 'Tables',
  view: 'Vues',
  matview: 'Vues matérialisées',
  function: 'Fonctions',
  procedure: 'Procédures',
  trigger: 'Triggers',
};

const STATUS_LABEL = { added: 'À créer', changed: 'À modifier', removed: 'À supprimer' };

function StatusIcon({ s }: { s: DiffItem['status'] }) {
  const p = { className: `diff-ico ${s}` };
  return s === 'added' ? <Plus {...p} /> : s === 'removed' ? <Minus {...p} /> : <Pencil {...p} />;
}

function SidePicker({ label, side, onChange, kind }: { label: string; side: Side; onChange: (s: Side) => void; kind?: string }) {
  const connections = useApp((s) => s.connections);
  const conn = connections.find((c) => c.id === side.connectionId);
  const [dbs, setDbs] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);

  useEffect(() => {
    setDbs([]);
    if (!conn?.connected) return;
    api.databases(conn.id).then(setDbs).catch(() => {});
  }, [conn?.id, conn?.connected]);

  useEffect(() => {
    setSchemas([]);
    if (!conn?.connected || !side.database) return;
    if (conn.kind === 'mysql') return;
    api.schemas(conn.id, side.database).then(setSchemas).catch(() => {});
  }, [conn?.id, conn?.connected, side.database]);

  return (
    <div className="cmp-side">
      <span className="cmp-label">{label}</span>
      <select
        className="input small"
        value={side.connectionId ?? ''}
        onChange={async (e) => {
          const id = e.target.value || null;
          const c = connectionById(id);
          onChange({ connectionId: id, database: c?.database ?? '', schema: c?.kind === 'postgres' ? 'public' : c?.database ?? '' });
          if (id) await ensureConnected(id);
        }}
        aria-label={`Connexion ${label}`}
      >
        <option value="">Connexion…</option>
        {connections
          .filter((c) => !kind || c.kind === kind)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </select>
      <select
        className="input small"
        value={side.database}
        disabled={!conn}
        onChange={(e) => onChange({ ...side, database: e.target.value, schema: conn?.kind === 'mysql' ? e.target.value : side.schema || 'public' })}
        aria-label={`Base ${label}`}
      >
        {!dbs.includes(side.database) && <option value={side.database}>{side.database || 'Base…'}</option>}
        {dbs.map((d) => (
          <option key={d}>{d}</option>
        ))}
      </select>
      {conn?.kind === 'postgres' && (
        <select className="input small" value={side.schema} onChange={(e) => onChange({ ...side, schema: e.target.value })} aria-label={`Schéma ${label}`}>
          {!schemas.includes(side.schema) && <option value={side.schema}>{side.schema || 'Schéma…'}</option>}
          {schemas.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      )}
    </div>
  );
}

export function CompareTab({ tab, active }: { tab: CTab; active: boolean }) {
  const src = tab.source;
  const tgt = tab.target;
  const srcConn = useApp((s) => s.connections.find((c) => c.id === src.connectionId));
  const tgtConn = useApp((s) => s.connections.find((c) => c.id === tgt.connectionId));
  const [result, setResult] = useState<DiffResult | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [busy, setBusy] = useState<'compare' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showScript, setShowScript] = useState(false);
  const [filter, setFilter] = useState<Set<DiffItem['status']>>(new Set(['added', 'changed', 'removed']));
  const kind = srcConn?.kind;
  const ready = !!(srcConn && tgtConn && src.database && tgt.database && src.schema && tgt.schema);
  const sameSide = src.connectionId === tgt.connectionId && src.database === tgt.database && src.schema === tgt.schema;

  const compare = async () => {
    if (!ready || !kind) return;
    if (srcConn!.kind !== tgtConn!.kind) return setError('La source et la cible doivent être du même type (PostgreSQL ↔ PostgreSQL, MySQL ↔ MySQL).');
    setBusy('compare');
    setError(null);
    try {
      if (!(await ensureConnected(src.connectionId!)) || !(await ensureConnected(tgt.connectionId!))) return;
      const [a, b] = await Promise.all([api.snapshot(src.connectionId!, src.database, src.schema), api.snapshot(tgt.connectionId!, tgt.database, tgt.schema)]);
      const r = diffSchemas(a, b, { targetSchema: tgt.schema });
      setResult(r);
      setChecked(new Set(r.items.filter((i) => !i.destructive).map((i) => i.id)));
      setCurrent(r.items.find((i) => !i.auto)?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const visible = useMemo(() => (result ? result.items.filter((i) => !i.auto) : []), [result]);
  const selected = useMemo(() => visible.filter((i) => checked.has(i.id)), [visible, checked]);
  const header = useMemo(() => {
    const d = (s: Side) => {
      const c = connectionById(s.connectionId);
      return `${c?.name ?? '?'} · ${s.database}${kind === 'postgres' ? '.' + s.schema : ''}`;
    };
    return `KSDB Studio : synchronisation de schéma\nSource : ${d(src)}\nCible  : ${d(tgt)}\nGénéré le ${new Date().toLocaleString('fr-FR')}`;
  }, [src, tgt, kind, result]);
  const script = useMemo(() => (kind && selected.length ? buildScript(kind, selected, header, result?.items) : ''), [kind, selected, header, result]);

  const counts = useMemo(() => {
    const c = { added: 0, changed: 0, removed: 0 };
    for (const i of visible) c[i.status]++;
    return c;
  }, [result]);

  const groups = useMemo(() => {
    const m = new Map<DiffItem['type'], DiffItem[]>();
    for (const i of visible) if (filter.has(i.status)) (m.get(i.type) ?? m.set(i.type, []).get(i.type)!).push(i);
    return [...m.entries()];
  }, [visible, filter]);

  const cur = result?.items.find((i) => i.id === current);
  const toggle = (id: string) => setChecked((s) => (s.has(id) ? (s.delete(id), new Set(s)) : new Set(s.add(id))));

  const execute = async () => {
    if (!script || !tgtConn || !kind) return;
    const destructive = selected.filter((i) => i.destructive);
    const ok = await confirmDialog(
      `Appliquer ${selected.length} modification(s) sur ${tgtConn.name} · ${tgt.database}${kind === 'postgres' ? '.' + tgt.schema : ''} ?`,
      [
        tgtConn.production ? '⚠ Connexion de PRODUCTION.' : '',
        destructive.length ? `⚠ ${destructive.length} opération(s) supprimant des objets ou des données : ${destructive.map((i) => i.name).join(', ')}.` : '',
        kind === 'postgres'
          ? 'Le script est exécuté dans une transaction : en cas d’erreur, rien n’est appliqué.'
          : 'MySQL valide chaque instruction de structure immédiatement : en cas d’erreur, les instructions précédentes restent appliquées. Fais une sauvegarde avant.',
      ]
        .filter(Boolean)
        .join('\n\n'),
      { danger: true, confirmLabel: 'Appliquer' },
    );
    if (!ok) return;
    setBusy('run');
    const sid = 'compare-' + tab.id;
    try {
      const res = await api.execute(tgt.connectionId!, sid, tgt.database, kind === 'postgres' ? `BEGIN;\n${script}\nCOMMIT;` : script);
      const err = res.find((r) => r.error);
      if (err) {
        if (kind === 'postgres') await api.execute(tgt.connectionId!, sid, tgt.database, 'ROLLBACK').catch(() => {});
        setError(`${err.error}\n\nInstruction : ${err.statement}${kind === 'postgres' ? '\n\nTransaction annulée : la cible n’a pas été modifiée.' : ''}`);
        return;
      }
      toast(`Cible synchronisée (${selected.length} objet(s))`, 'success');
      invalidateCompletion(tgt.connectionId!);
      bumpTree(`${tgt.connectionId}|${tgt.database}|${tgt.schema}`);
      bumpTree(`${tgt.connectionId}|${tgt.database}`);
      await compare();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      api.closeSession(tgt.connectionId!, sid).catch(() => {});
      setBusy(null);
    }
  };

  const saveScript = async () => {
    const f = await api.saveDialog({ defaultPath: `sync_${tgt.database}${kind === 'postgres' ? '_' + tgt.schema : ''}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] });
    if (!f) return;
    await api.writeText(f, script);
    toast('Script enregistré', 'success');
  };

  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="toolbar cmp-bar">
        <SidePicker label="Source" side={src} onChange={(s) => updateTab(tab.id, { source: s } as Partial<Tab>)} />
        <button className="btn icon" title="Inverser source et cible" onClick={() => updateTab(tab.id, { source: tgt, target: src } as Partial<Tab>)}>
          <ArrowLeftRight />
        </button>
        <SidePicker label="Cible" side={tgt} kind={kind} onChange={(s) => updateTab(tab.id, { target: s } as Partial<Tab>)} />
        <button className="btn primary" disabled={!ready || sameSide || busy !== null} onClick={compare} style={{ marginLeft: 'auto' }}>
          {busy === 'compare' ? <Loader2 className="spin" /> : <GitCompareArrows />} Comparer
        </button>
      </div>
      {error && <div className="banner err">{error}</div>}
      {sameSide && ready && <div className="banner info">La source et la cible sont identiques : choisis une autre base ou un autre schéma.</div>}

      {!result ? (
        <div className="empty-state">
          <div className="inner">
            Choisis une <b>source</b> (la référence, par exemple dev) et une <b>cible</b> (à mettre à jour, par exemple prod), puis lance la comparaison.
            <br />
            <br />
            Le script généré modifie uniquement la cible pour qu’elle corresponde à la source. Les suppressions sont décochées par défaut.
          </div>
        </div>
      ) : (
        <div className="cmp-body">
          <div className="cmp-list">
            <div className="cmp-filters">
              {(['added', 'changed', 'removed'] as const).map((s) => (
                <button
                  key={s}
                  className={`cmp-chip ${s} ${filter.has(s) ? 'on' : ''}`}
                  onClick={() => setFilter((f) => (f.has(s) ? (f.delete(s), new Set(f)) : new Set(f.add(s))))}
                >
                  <StatusIcon s={s} /> {STATUS_LABEL[s]} {counts[s]}
                </button>
              ))}
              <span className="hint" style={{ marginLeft: 'auto' }}>
                {result.identical} identique{result.identical > 1 ? 's' : ''}
              </span>
            </div>
            {!visible.length && (
              <div className="empty-state">
                <div className="inner">Aucune différence : la cible est déjà alignée sur la source.</div>
              </div>
            )}
            {groups.map(([type, items]) => {
              const all = items.every((i) => checked.has(i.id));
              return (
                <div key={type}>
                  <label className="cmp-group">
                    <input
                      type="checkbox"
                      checked={all}
                      onChange={() =>
                        setChecked((s) => {
                          const n = new Set(s);
                          for (const i of items) all ? n.delete(i.id) : n.add(i.id);
                          return n;
                        })
                      }
                    />
                    {TYPE_LABEL[type]} <span className="hint">({items.length})</span>
                  </label>
                  {items.map((i) => (
                    <div key={i.id} className={`cmp-row ${current === i.id ? 'current' : ''}`} onClick={() => setCurrent(i.id)}>
                      <input type="checkbox" checked={checked.has(i.id)} onChange={() => toggle(i.id)} onClick={(e) => e.stopPropagation()} aria-label={`Inclure ${i.name}`} />
                      <StatusIcon s={i.status} />
                      <span className="nm">{i.name}</span>
                      {i.destructive && <AlertTriangle className="warn-ico" aria-label="Supprime des données" />}
                      <span className="hint sm">{i.details.length > 1 ? `${i.details.length} changements` : ''}</span>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
          <div className="cmp-detail">
            {cur ? (
              <>
                <h3>
                  <StatusIcon s={cur.status} /> {cur.name} <span className="hint">· {STATUS_LABEL[cur.status]}</span>
                </h3>
                <ul className="cmp-details">
                  {cur.details.map((d, k) => (
                    <li key={k} className={d.startsWith('+') ? 'add' : d.startsWith('−') ? 'del' : d.startsWith('~') ? 'mod' : ''}>
                      {d}
                    </li>
                  ))}
                </ul>
                {cur.warnings.map((w, k) => (
                  <div key={k} className="banner warn" style={{ borderRadius: 6, marginBottom: 6 }}>
                    <AlertTriangle /> {w}
                  </div>
                ))}
                <div className="hint" style={{ margin: '12px 0 6px' }}>
                  SQL exécuté sur la cible
                </div>
                <pre className="sql-preview" style={{ maxHeight: 'none' }}>
                  {kind ? buildScript(kind, [cur], undefined, result.items).replace(/^SET FOREIGN_KEY_CHECKS = [01];\n\n?/gm, '').trim() : ''}
                </pre>
              </>
            ) : (
              <div className="empty-state">Sélectionne un objet pour voir le détail.</div>
            )}
          </div>
        </div>
      )}

      {result && (
        <div className="result-footer">
          <span>
            {selected.length} / {visible.length} sélectionné(s)
            {selected.some((i) => i.destructive) && <span className="warn"> · contient des suppressions</span>}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={!script} onClick={() => setShowScript(true)}>
            <FileCode /> Voir le script
          </button>
          <button className="btn" disabled={!script} onClick={() => newQueryTab(tgt.connectionId, tgt.database, script, `Sync ${tgt.database}`)}>
            <ArrowRight /> Ouvrir dans l’éditeur
          </button>
          <button className="btn" disabled={!script} onClick={saveScript}>
            <Save /> Enregistrer
          </button>
          <button className="btn primary" disabled={!script || busy !== null} onClick={execute}>
            {busy === 'run' ? <Loader2 className="spin" /> : <Play />} Appliquer sur la cible
          </button>
        </div>
      )}

      {showScript && (
        <Modal
          title="Script de synchronisation"
          wide
          onClose={() => setShowScript(false)}
          footer={
            <>
              <button className="btn outline left" onClick={() => navigator.clipboard.writeText(script).then(() => toast('Script copié'))}>
                <Copy /> Copier
              </button>
              <button className="btn outline" onClick={() => setShowScript(false)}>
                Fermer
              </button>
            </>
          }
        >
          <pre className="sql-preview" style={{ maxHeight: '60vh' }}>
            {script}
          </pre>
        </Modal>
      )}
    </div>
  );
}
