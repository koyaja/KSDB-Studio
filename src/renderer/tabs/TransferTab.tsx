import { AlertTriangle, ArrowLeftRight, CheckCircle2, Circle, Filter, Loader2, MinusCircle, Play, RefreshCw, Square, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { TransferEvent, TransferOptions } from '../../shared/types';
import { api } from '../api';
import { trackJob } from '../jobs';
import { bumpTree, confirmDialog, connectionById, ensureConnected, Tab, toast, updateTab, useApp } from '../state';
import { SidePicker, Side } from './CompareTab';
import { invalidateCompletion } from './QueryTab';

type TTab = Extract<Tab, { kind: 'transfer' }>;

interface Row {
  name: string;
  rows: number | null;
  /** la table existe déjà dans la cible */
  exists: boolean;
}

type TState = { state: 'pending' | 'running' | 'done' | 'error' | 'skipped'; rows?: number; error?: string; note?: string };

const fmt = (n: number) => n.toLocaleString('fr-FR');

function StateIcon({ s }: { s?: TState }) {
  if (!s) return null;
  if (s.state === 'running') return <Loader2 className="spin xf-ico run" />;
  if (s.state === 'done') return <CheckCircle2 className="xf-ico ok" />;
  if (s.state === 'error') return <XCircle className="xf-ico err" />;
  if (s.state === 'skipped') return <MinusCircle className="xf-ico skip" />;
  return <Circle className="xf-ico pend" />;
}

export function TransferTab({ tab, active }: { tab: TTab; active: boolean }) {
  const src = tab.source;
  const tgt = tab.target;
  const srcConn = useApp((s) => s.connections.find((c) => c.id === src.connectionId));
  const tgtConn = useApp((s) => s.connections.find((c) => c.id === tgt.connectionId));
  const sameKind = !!srcConn && !!tgtConn && srcConn.kind === tgtConn.kind;
  const ready = !!(srcConn && tgtConn && src.database && tgt.database && src.schema && tgt.schema);
  const sameSide = src.connectionId === tgt.connectionId && src.database === tgt.database && src.schema === tgt.schema;

  const [rows, setRows] = useState<Row[] | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set(tab.tables ?? []));
  const [where, setWhere] = useState<Record<string, string>>({});
  const [editWhere, setEditWhere] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const [structure, setStructure] = useState<TransferOptions['structure']>('existing');
  const [data, setData] = useState(true);
  const [before, setBefore] = useState<TransferOptions['before']>('append');
  const [ignore, setIgnore] = useState(false);
  const [resetSeq, setResetSeq] = useState(true);
  const [disableChecks, setDisableChecks] = useState(false);
  const [continueOnError, setContinueOnError] = useState(true);
  const [batchSize, setBatchSize] = useState(1000);

  const [jobId, setJobId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, TState>>({});
  const [log, setLog] = useState<{ t: string; m: string }[]>([]);
  const [summary, setSummary] = useState<Extract<TransferEvent, { type: 'summary' }> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const running = jobId !== null;

  useEffect(() => {
    if (!sameKind && structure !== 'existing') setStructure('existing');
  }, [sameKind]);

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const load = async () => {
    if (!ready) return;
    setLoading(true);
    setError(null);
    try {
      if (!(await ensureConnected(src.connectionId!)) || !(await ensureConnected(tgt.connectionId!))) return;
      const [model, objs] = await Promise.all([
        api.erd(src.connectionId!, src.database, src.schema),
        api.objects(tgt.connectionId!, tgt.database, tgt.schema).catch(() => []),
      ]);
      const existing = new Set(objs.filter((o) => o.type === 'table').map((o) => o.name.toLowerCase()));
      const list = model.tables
        .filter((t) => t.kind === 'table')
        .map((t) => ({ name: t.name, rows: t.rows, exists: existing.has(t.name.toLowerCase()) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      setRows(list);
      setChecked((prev) => {
        const keep = list.filter((r) => prev.has(r.name)).map((r) => r.name);
        return new Set(keep.length ? keep : list.map((r) => r.name));
      });
      setStates({});
      setSummary(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  // recharge automatiquement quand les deux côtés sont choisis
  useEffect(() => {
    if (ready && !sameSide && !running) load();
    else if (!ready) setRows(null);
  }, [src.connectionId, src.database, src.schema, tgt.connectionId, tgt.database, tgt.schema, srcConn?.connected, tgtConn?.connected]);

  const visible = useMemo(() => (rows ?? []).filter((r) => !search || r.name.toLowerCase().includes(search.toLowerCase())), [rows, search]);
  const selected = useMemo(() => (rows ?? []).filter((r) => checked.has(r.name)), [rows, checked]);
  const missing = selected.filter((r) => !r.exists);
  const estRows = selected.reduce((n, r) => n + Math.max(0, r.rows ?? 0), 0);
  const allVisible = visible.length > 0 && visible.every((r) => checked.has(r.name));
  const toggle = (n: string) => setChecked((s) => (s.has(n) ? (s.delete(n), new Set(s)) : new Set(s.add(n))));

  const done = Object.values(states).filter((s) => s.state === 'done' || s.state === 'error' || s.state === 'skipped').length;
  const copied = Object.values(states).reduce((n, s) => n + (s.rows ?? 0), 0);
  const total = Object.keys(states).length;
  const progress = !running ? (summary || total ? 1 : null) : estRows > 0 ? Math.min(0.99, Math.max(done / Math.max(total, 1), copied / estRows)) : total ? done / total : null;

  const label = (s: Side, c = connectionById(s.connectionId)) => `${c?.name ?? '?'} · ${s.database}${c?.kind === 'postgres' ? '.' + s.schema : ''}`;

  const start = async () => {
    if (!ready || !selected.length) return;
    const blocking = structure === 'existing' ? missing : [];
    if (blocking.length && !(await confirmDialog(
      `${blocking.length} table(s) absente(s) de la cible`,
      `${blocking.map((r) => r.name).join(', ')}\n\nElles seront ignorées.${sameKind ? ' Choisis « Créer les tables manquantes » pour les créer.' : ''}`,
      { confirmLabel: 'Continuer' },
    )))
      return;
    const toRun = selected.filter((r) => !blocking.includes(r));
    if (!toRun.length) return;
    const warn = [
      tgtConn?.production ? '⚠ La cible est une connexion de PRODUCTION.' : '',
      structure === 'recreate' ? `⚠ Les ${selected.length} table(s) sélectionnée(s) seront SUPPRIMÉES puis recréées dans la cible (données existantes perdues).` : '',
      structure !== 'recreate' && data && before === 'truncate' ? `⚠ Les tables de la cible seront VIDÉES avant la copie.` : '',
      `${toRun.length} table(s), environ ${fmt(toRun.reduce((n, r) => n + Math.max(0, r.rows ?? 0), 0))} ligne(s).`,
    ].filter(Boolean);
    if (!(await confirmDialog(`Transférer vers ${label(tgt)} ?`, warn.join('\n\n'), { danger: warn.length > 1, confirmLabel: 'Transférer' }))) return;

    const o: TransferOptions = {
      source: { connectionId: src.connectionId!, database: src.database, schema: src.schema },
      target: { connectionId: tgt.connectionId!, database: tgt.database, schema: tgt.schema },
      tables: toRun.map((r) => ({ name: r.name, where: where[r.name]?.trim() || undefined })),
      structure,
      data,
      before,
      onConflict: ignore ? 'ignore' : 'error',
      resetSequences: resetSeq,
      disableChecks,
      continueOnError,
      batchSize: Math.max(50, Math.min(50000, batchSize || 1000)),
    };
    setStates(Object.fromEntries(selected.map((r) => [r.name, (blocking.includes(r) ? { state: 'skipped', note: 'Ignorée : absente de la cible' } : { state: 'pending' }) as TState])));
    setLog([]);
    setSummary(null);
    setError(null);
    const t0 = Date.now();
    const { jobId: idP, done: doneP } = trackJob(api.transfer(o), (ev) => {
      if (ev.kind === 'data') {
        const d = ev.data as TransferEvent;
        if (d.type === 'table') setStates((s) => ({ ...s, [d.table]: { state: d.state, rows: d.rows, error: d.error, note: d.note } }));
        else if (d.type === 'log') setLog((l) => [...l, { t: d.level === 'error' ? 'e' : d.level === 'warn' ? 'w' : '', m: d.message }]);
        else if (d.type === 'summary') setSummary(d);
      } else if (ev.kind === 'log' && ev.message) setLog((l) => [...l, { t: '', m: ev.message! }]);
    });
    idP.then(setJobId).catch(() => {});
    try {
      const msg = await doneP;
      setLog((l) => [...l, { t: 'd', m: msg }]);
      toast(msg, /erreur/.test(msg) ? 'error' : 'success');
    } catch (e) {
      const m = (e as Error).message;
      setError(m);
      setLog((l) => [...l, { t: 'e', m }]);
    } finally {
      setJobId(null);
      invalidateCompletion(tgt.connectionId!);
      bumpTree(`${tgt.connectionId}|${tgt.database}|${tgt.schema}`);
      bumpTree(`${tgt.connectionId}|${tgt.database}`);
      if (Date.now() - t0 > 0) {
        // met à jour « existe / à créer »
        api
          .objects(tgt.connectionId!, tgt.database, tgt.schema)
          .then((objs) => {
            const ex = new Set(objs.filter((x) => x.type === 'table').map((x) => x.name.toLowerCase()));
            setRows((rs) => rs?.map((r) => ({ ...r, exists: ex.has(r.name.toLowerCase()) })) ?? null);
          })
          .catch(() => {});
      }
    }
  };

  const seg = <T extends string>(value: T, set: (v: T) => void, opts: [T, string, boolean?][]) => (
    <div className="seg">
      {opts.map(([v, l, dis]) => (
        <button key={v} className={value === v ? 'active' : ''} disabled={dis || running} onClick={() => set(v)}>
          {l}
        </button>
      ))}
    </div>
  );

  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="toolbar cmp-bar">
        <SidePicker label="Source" side={src} onChange={(s) => updateTab(tab.id, { source: s } as Partial<Tab>)} />
        <button className="btn icon" title="Inverser source et cible" disabled={running} onClick={() => updateTab(tab.id, { source: tgt, target: src } as Partial<Tab>)}>
          <ArrowLeftRight />
        </button>
        <SidePicker label="Cible" side={tgt} onChange={(s) => updateTab(tab.id, { target: s } as Partial<Tab>)} />
        <button className="btn" disabled={!ready || sameSide || loading || running} onClick={load} style={{ marginLeft: 'auto' }} title="Recharger la liste des tables">
          {loading ? <Loader2 className="spin" /> : <RefreshCw />} Actualiser
        </button>
      </div>
      {error && <div className="banner err" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
      {sameSide && ready && <div className="banner info">La source et la cible sont identiques : choisis une autre base ou un autre schéma.</div>}
      {ready && !sameKind && (
        <div className="banner info">
          Transfert entre moteurs différents ({srcConn!.kind === 'postgres' ? 'PostgreSQL → MySQL' : 'MySQL → PostgreSQL'}) : les tables doivent déjà exister dans la cible. Les colonnes sont associées par nom et les valeurs converties (booléens, JSON, dates).
        </div>
      )}

      {!rows ? (
        <div className="empty-state">
          <div className="inner">
            Choisis une <b>source</b> et une <b>cible</b> : PostgreSQL ou MySQL/MariaDB, sur le même serveur ou deux serveurs différents (tunnels SSH et VPN compris).
            <br />
            <br />
            Les données sont lues en flux et insérées par lots, table par table, dans l’ordre des clés étrangères.
          </div>
        </div>
      ) : (
        <div className="cmp-body xf-body">
          <div className="cmp-list">
            <div className="cmp-filters">
              <input type="checkbox" checked={allVisible} disabled={running} aria-label="Tout sélectionner"
                onChange={() => setChecked((s) => { const n = new Set(s); for (const r of visible) allVisible ? n.delete(r.name) : n.add(r.name); return n; })} />
              <input className="input small" placeholder="Filtrer les tables…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1 }} />
              <span className="hint">{selected.length} / {rows.length}</span>
            </div>
            {!rows.length && (
              <div className="empty-state">
                <div className="inner">Aucune table dans la source.</div>
              </div>
            )}
            {visible.map((r) => {
              const st = states[r.name];
              const w = where[r.name];
              return (
                <div key={r.name}>
                  <div className={`cmp-row xf-row ${checked.has(r.name) ? '' : 'off'}`} onClick={() => !running && toggle(r.name)}>
                    <input type="checkbox" checked={checked.has(r.name)} disabled={running} onChange={() => toggle(r.name)} onClick={(e) => e.stopPropagation()} aria-label={`Inclure ${r.name}`} />
                    <span className="nm">{r.name}</span>
                    {!r.exists && <span className="xf-tag" title="Absente de la cible">{structure === 'existing' ? 'absente' : 'à créer'}</span>}
                    {w?.trim() && <span className="xf-tag where" title={`WHERE ${w}`}>filtrée</span>}
                    <span className="hint sm">
                      {st && st.rows !== undefined ? fmt(st.rows) : r.rows !== null && r.rows >= 0 ? `≈ ${fmt(r.rows)}` : ''}
                    </span>
                    <button className={`btn icon tiny ${w?.trim() ? 'on' : ''}`} title="Filtre WHERE" disabled={running}
                      onClick={(e) => { e.stopPropagation(); setEditWhere(editWhere === r.name ? null : r.name); }}>
                      <Filter />
                    </button>
                    <StateIcon s={st} />
                  </div>
                  {editWhere === r.name && (
                    <div className="xf-where">
                      <span className="mono hint">WHERE</span>
                      <input className="input small mono" autoFocus placeholder="ex. cree_le >= '2026-01-01'" value={w ?? ''}
                        onChange={(e) => setWhere((m) => ({ ...m, [r.name]: e.target.value }))}
                        onKeyDown={(e) => (e.key === 'Enter' || e.key === 'Escape') && setEditWhere(null)} />
                    </div>
                  )}
                  {st?.error && <div className="xf-err">{st.error}</div>}
                  {st?.note && !st.error && <div className="xf-note">{st.note}</div>}
                </div>
              );
            })}
          </div>

          <div className="cmp-detail xf-opts">
            <h3>Structure</h3>
            {seg(structure, setStructure, [
              ['existing', 'Tables existantes'],
              ['create', 'Créer les manquantes', !sameKind],
              ['recreate', 'Supprimer et recréer', !sameKind],
            ])}
            <p className="hint xf-help">
              {structure === 'existing' && 'Copie dans les tables déjà présentes ; colonnes associées par nom.'}
              {structure === 'create' && 'Les tables absentes sont créées avec leurs index ; les clés étrangères sont ajoutées après les données.'}
              {structure === 'recreate' && 'Les tables sélectionnées sont supprimées dans la cible puis recréées à l’identique de la source.'}
            </p>

            <h3>Données</h3>
            <label className="check">
              <input type="checkbox" checked={data} disabled={running} onChange={(e) => setData(e.target.checked)} /> Copier les données
            </label>
            {data && (
              <>
                {structure !== 'recreate' && (
                  <div style={{ margin: '8px 0' }}>
                    {seg(before, setBefore, [
                      ['append', 'Ajouter aux données existantes'],
                      ['truncate', 'Vider la table avant'],
                    ])}
                  </div>
                )}
                <label className="check">
                  <input type="checkbox" checked={ignore} disabled={running} onChange={(e) => setIgnore(e.target.checked)} /> Ignorer les lignes en double (clé déjà présente)
                </label>
                <label className="check">
                  <input type="checkbox" checked={resetSeq} disabled={running} onChange={(e) => setResetSeq(e.target.checked)} /> Recaler les séquences / auto-incréments
                </label>
                <label className="check">
                  <input type="checkbox" checked={disableChecks} disabled={running} onChange={(e) => setDisableChecks(e.target.checked)} /> Désactiver les contraintes pendant la copie
                </label>
                {disableChecks && tgtConn?.kind === 'postgres' && <p className="hint xf-help">PostgreSQL : nécessite un superutilisateur (session_replication_role).</p>}
                <label className="check">
                  <input type="checkbox" checked={continueOnError} disabled={running} onChange={(e) => setContinueOnError(e.target.checked)} /> Continuer si une table échoue
                </label>
                <label className="check" style={{ gap: 8 }}>
                  Taille des lots
                  <input className="input small" type="number" min={50} max={50000} step={500} value={batchSize} disabled={running} onChange={(e) => setBatchSize(Number(e.target.value))} style={{ width: 90 }} />
                </label>
              </>
            )}
            <p className="hint xf-help">Chaque table est copiée dans une transaction : en cas d’erreur, elle reste dans son état d’origine.</p>

            {(running || log.length > 0) && (
              <>
                <h3>Progression</h3>
                <div className={`progress ${progress === null ? 'indeterminate' : ''}`}>
                  <div style={progress === null ? undefined : { width: `${Math.round(progress * 100)}%` }} />
                </div>
                <div className="hint">
                  {done} / {total} table(s) · {fmt(copied)} ligne(s)
                  {summary && ` · ${summary.seconds.toFixed(1)} s${summary.errors ? ` · ${summary.errors} erreur(s)` : ''}`}
                </div>
                {log.length > 0 && (
                  <div className="joblog" ref={logRef} style={{ marginTop: 10, maxHeight: 180 }}>
                    {log.map((l, i) => (
                      <div key={i} className={l.t}>
                        {l.m}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {rows && (
        <div className="result-footer">
          <span>
            {selected.length} table(s) · ≈ {fmt(estRows)} ligne(s)
            {structure === 'recreate' && <span className="warn"> · les tables cibles seront recréées</span>}
            {structure === 'existing' && missing.length > 0 && (
              <span className="warn">
                {' '}
                · <AlertTriangle style={{ width: 12, height: 12, verticalAlign: -2 }} /> {missing.length} absente(s) de la cible
              </span>
            )}
          </span>
          <span style={{ flex: 1 }} />
          {running ? (
            <button className="btn outline" onClick={() => jobId && api.cancelJob(jobId)}>
              <Square /> Arrêter
            </button>
          ) : (
            <button className="btn primary" disabled={!selected.length || sameSide || (!data && structure === 'existing')} onClick={start}>
              <Play /> Transférer
            </button>
          )}
        </div>
      )}
    </div>
  );
}
