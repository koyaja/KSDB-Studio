import {
  AlignLeft,
  FileDown,
  FolderOpen,
  Gauge,
  ListChecks,
  Loader2,
  Play,
  PlaySquare,
  Save,
  Square,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { format as formatSql } from 'sql-formatter';
import { isRisky, splitSql } from '../../shared/sqlsplit';
import { isWriteStatement, parsePlan, Plan } from '../../shared/explain';
import { PlanView } from '../components/PlanView';
import type { ExportFormat, QueryResult } from '../../shared/types';
import { api, Completion } from '../api';
import { DataGrid } from '../components/DataGrid';
import { FORMATS } from '../components/ExportDialog';
import { fmtInt, formatDuration, Modal, openMenu, useDrag } from '../components/ui';
import { SqlEditor, SqlEditorHandle } from '../components/SqlEditor';
import { confirmDialog, connectionById, ensureConnected, setState, Tab, toast, updateTab, useApp } from '../state';

type QTab = Extract<Tab, { kind: 'query' }>;

const completionCache = new Map<string, Promise<Completion>>();
export function invalidateCompletion(connId: string) {
  for (const k of completionCache.keys()) if (k.startsWith(connId + '|')) completionCache.delete(k);
}

export function QueryTab({ tab, active }: { tab: QTab; active: boolean }) {
  const connections = useApp((s) => s.connections);
  const settings = useApp((s) => s.settings);
  const dark = useApp((s) => s.themeDark);
  const conn = connections.find((c) => c.id === tab.connectionId);
  const editor = useRef<SqlEditorHandle>(null);
  const [results, setResults] = useState<QueryResult[]>([]);
  const [view, setView] = useState<number | 'messages' | 'plan'>('messages');
  const [plan, setPlan] = useState<{ plan: Plan; rolledBack: boolean; sql: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [dbs, setDbs] = useState<string[]>([]);
  const [completion, setCompletion] = useState<Completion | null>(null);
  const [editorH, setEditorH] = useState(0.45);
  const [exporting, setExporting] = useState<QueryResult | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Liste des bases + autocomplétion quand la connexion est active
  useEffect(() => {
    if (!conn?.connected) return;
    api.databases(conn.id).then(setDbs).catch(() => setDbs([]));
  }, [conn?.id, conn?.connected]);

  useEffect(() => {
    if (!conn?.connected || !tab.database) return setCompletion(null);
    const key = `${conn.id}|${tab.database}`;
    if (!completionCache.has(key)) completionCache.set(key, api.completion(conn.id, tab.database));
    let alive = true;
    completionCache.get(key)!.then((c) => alive && setCompletion(c)).catch(() => completionCache.delete(key));
    return () => {
      alive = false;
    };
  }, [conn?.id, conn?.connected, tab.database]);

  useEffect(() => {
    if (!running) return;
    const t0 = performance.now();
    const h = setInterval(() => setElapsed(performance.now() - t0), 100);
    return () => clearInterval(h);
  }, [running]);

  const run = async (mode: 'smart' | 'all', wrap?: (s: string) => string) => {
    if (running) return;
    if (!tab.connectionId || !conn) return toast('Choisis d’abord une connexion dans la barre d’outils.', 'error');
    let sql = mode === 'all' ? editor.current!.allText() : editor.current!.smartText()?.text ?? '';
    if (!sql.trim()) return;
    if (wrap) sql = wrap(splitSql(sql, conn.kind)[0]?.text ?? sql);
    if (conn.production) {
      const risky = splitSql(sql, conn.kind)
        .map((s) => ({ s: s.text, why: isRisky(s.text) }))
        .filter((x) => x.why);
      if (risky.length) {
        const ok = await confirmDialog(
          `Connexion de production : ${conn.name}`,
          `${risky[0].why} :\n\n${risky.map((r) => r.s).join(';\n').slice(0, 800)}\n\nExécuter quand même ?`,
          { danger: true, confirmLabel: 'Exécuter' },
        );
        if (!ok) return;
      }
    }
    if (!(await ensureConnected(conn.id))) return;
    setRunning(true);
    setElapsed(0);
    try {
      const res = await api.execute(conn.id, tab.id, tab.database, sql);
      setResults(res);
      const firstGrid = res.findIndex((r) => r.fields.length > 0 && !r.error);
      setView(res.some((r) => r.error) ? 'messages' : firstGrid >= 0 ? firstGrid : 'messages');
      if (res.some((r) => /^\s*(create|drop|alter|rename)\b/i.test(r.statement) && !r.error)) {
        invalidateCompletion(conn.id);
        setState((s) => ({ treeVersion: Object.fromEntries(Object.entries(s.treeVersion).map(([k, v]) => [k, k.startsWith(conn.id) ? v + 1 : v])) }));
      }
    } catch (e) {
      setResults([{ statement: sql, fields: [], rows: [], rowCount: 0, durationMs: 0, error: (e as Error).message }]);
      setView('messages');
    } finally {
      setRunning(false);
    }
  };

  const stop = async () => {
    if (!conn) return;
    try {
      await api.cancel(conn.id, tab.id);
      toast('Annulation demandée');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const doFormat = () => {
    const ed = editor.current!;
    const sel = ed.selectionRange();
    const language = conn?.kind === 'mysql' ? (conn.flavor === 'mariadb' ? 'mariadb' : 'mysql') : 'postgresql';
    try {
      const fmt = (s: string) => formatSql(s, { language, keywordCase: settings.uppercaseKeywords ? 'upper' : 'preserve', tabWidth: 2 });
      if (sel.from !== sel.to) ed.replaceRange(sel.from, sel.to, fmt(ed.allText().slice(sel.from, sel.to)));
      else ed.setText(fmt(ed.allText()));
    } catch (e) {
      toast(`Formatage impossible : ${(e as Error).message.split('\n')[0]}`, 'error');
    }
  };

  const save = async (as = false) => {
    let file = tab.filePath;
    if (!file || as) {
      file = (await api.saveDialog({ defaultPath: `${tab.title}.sql`, filters: [{ name: 'SQL', extensions: ['sql'] }] })) ?? undefined;
      if (!file) return;
    }
    await api.writeText(file, editor.current!.allText());
    updateTab(tab.id, { filePath: file, dirty: false, title: file.split(/[\\/]/).pop()!.replace(/\.sql$/i, '') });
    toast('Script enregistré', 'success');
  };

  const open = async () => {
    const files = await api.openDialog({ filters: [{ name: 'SQL', extensions: ['sql', 'txt'] }], properties: ['openFile'] });
    if (!files?.[0]) return;
    const text = await api.readText(files[0]);
    updateTab(tab.id, { sql: text, filePath: files[0], dirty: false, title: files[0].split(/[\\/]/).pop()!.replace(/\.sql$/i, '') });
  };

  const explain = async (analyze: boolean, sqlOverride?: string) => {
    if (running) return;
    if (!tab.connectionId || !conn) return toast('Choisis d’abord une connexion dans la barre d’outils.', 'error');
    const raw = sqlOverride ?? editor.current!.smartText()?.text ?? '';
    const sql = splitSql(raw, conn.kind)[0]?.text ?? raw;
    if (!sql.trim()) return;
    if (analyze && isWriteStatement(sql)) {
      const ok = await confirmDialog(
        'Mesurer une instruction qui modifie des données ?',
        [
          conn.production ? '⚠ Connexion de PRODUCTION.' : '',
          'ANALYZE exécute réellement l’instruction, dans une transaction annulée ensuite (ROLLBACK).',
          conn.kind === 'mysql' ? 'MySQL / MariaDB : les ordres de structure (CREATE, ALTER, DROP…) et les tables MyISAM ne peuvent pas être annulés.' : '',
          'Les séquences / auto-incréments consommés ne reviennent pas en arrière.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        { danger: true, confirmLabel: 'Mesurer' },
      );
      if (!ok) return;
    }
    if (!(await ensureConnected(conn.id))) return;
    setRunning(true);
    setElapsed(0);
    try {
      const out = await api.explain(conn.id, tab.id, tab.database, sql, analyze);
      setPlan({ plan: parsePlan(out.format, out.engine, out.output), rolledBack: out.rolledBack, sql });
      setView('plan');
    } catch (e) {
      setResults([{ statement: sql, fields: [], rows: [], rowCount: 0, durationMs: 0, error: (e as Error).message }]);
      setView('messages');
    } finally {
      setRunning(false);
    }
  };

  const dragEditor = useDrag(
    (_dx, dy) => {
      const h = containerRef.current?.clientHeight ?? 600;
      setEditorH((v) => Math.min(0.85, Math.max(0.12, startH.current + dy / h)));
    },
  );
  const startH = useRef(editorH);

  const current = typeof view === 'number' ? results[view] : null;
  const gridResults = useMemo(() => results.map((r, i) => ({ r, i })).filter((x) => x.r.fields.length > 0), [results]);

  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="toolbar">
        <button className="btn run" onClick={() => run('smart')} disabled={running} title="Exécuter la sélection ou l’instruction courante (Ctrl+Entrée)">
          <Play /> Exécuter
        </button>
        <button className="btn" onClick={() => run('all')} disabled={running} title="Tout exécuter (F5 ou Ctrl+Maj+Entrée)">
          <PlaySquare /> Tout
        </button>
        <button className="btn" onClick={stop} disabled={!running} title="Annuler la requête en cours">
          <Square /> Arrêter
        </button>
        <button
          className="btn"
          disabled={running}
          title="Plan d’exécution (Ctrl+E)"
          onClick={(e) =>
            openMenu(e, [
              { label: 'Plan estimé (Ctrl+E)', icon: <Gauge />, onClick: () => explain(false) },
              { label: 'Plan mesuré : exécute la requête (Ctrl+Maj+E)', icon: <Gauge />, onClick: () => explain(true) },
            ])
          }
        >
          <Gauge /> Plan
        </button>
        <button className="btn" onClick={doFormat} title="Formater (Ctrl+Maj+F)">
          <AlignLeft /> Formater
        </button>
        <span className="sep" />
        <div className="ctx-select">
          <span className="dot" style={{ background: conn?.color ?? 'var(--line-strong)' }} />
          <select
            className="input"
            value={tab.connectionId ?? ''}
            onChange={async (e) => {
              const id = e.target.value || null;
              const c = connectionById(id);
              updateTab(tab.id, { connectionId: id, database: c?.database || '' });
              if (id) await ensureConnected(id);
            }}
            aria-label="Connexion"
          >
            <option value="">Choisir une connexion…</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select className="input" value={tab.database} onChange={(e) => updateTab(tab.id, { database: e.target.value })} aria-label="Base de données" disabled={!conn}>
            {!dbs.includes(tab.database) && <option value={tab.database}>{tab.database || '(par défaut)'}</option>}
            {dbs.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <span className="grow" />
        <button className="btn icon" onClick={open} title="Ouvrir un fichier .sql">
          <FolderOpen />
        </button>
        <button className="btn icon" onClick={() => save(false)} title="Enregistrer (Ctrl+S)" onContextMenu={(e) => openMenu(e, [{ label: 'Enregistrer sous…', onClick: () => save(true) }])}>
          <Save />
        </button>
      </div>

      <div className="vsplit" ref={containerRef}>
        <div style={{ flex: `0 0 ${editorH * 100}%`, display: 'flex', minHeight: 0 }}>
          <SqlEditor
            ref={editor}
            value={tab.sql}
            onChange={(sql) => updateTab(tab.id, { sql, dirty: !!tab.filePath })}
            kind={conn?.kind ?? 'postgres'}
            mariadb={conn?.flavor === 'mariadb'}
            completion={completion}
            fontSize={settings.editorFontSize}
            dark={dark}
            uppercase={settings.uppercaseKeywords}
            onRun={run}
            onFormat={doFormat}
            onSave={() => save(false)}
            onExplain={() => explain(false)}
            onExplainAnalyze={() => explain(true)}
          />
        </div>
        <div
          className="hsplitter"
          onMouseDown={(e) => {
            startH.current = editorH;
            dragEditor(e);
          }}
        />
        <div className="results" style={{ flex: 1 }}>
          <div className="result-tabs" role="tablist">
            {gridResults.map(({ r, i }, k) => (
              <button key={i} role="tab" className={view === i ? 'active' : ''} onClick={() => setView(i)} title={r.statement}>
                Résultat {gridResults.length > 1 ? k + 1 : ''}
                <span className="count">{fmtInt(r.rowCount)}</span>
              </button>
            ))}
            {plan && (
              <button role="tab" className={view === 'plan' ? 'active' : ''} onClick={() => setView('plan')} title={plan.sql}>
                <Gauge style={{ width: 14, height: 14 }} /> Plan
                {plan.plan.warnings.some((w) => w.level === 'warn') && <span className="err-dot warn" />}
              </button>
            )}
            <button role="tab" className={view === 'messages' ? 'active' : ''} onClick={() => setView('messages')}>
              <ListChecks style={{ width: 14, height: 14 }} /> Messages
              {results.some((r) => r.error) && <span className="err-dot" />}
            </button>
          </div>

          {running && (
            <div className="empty-state">
              <div className="inner">
                <Loader2 className="spin" style={{ width: 20, height: 20, color: 'var(--accent)' }} />
                <div style={{ marginTop: 8 }}>Exécution… {formatDuration(elapsed)}</div>
              </div>
            </div>
          )}
          {!running && view === 'messages' && <Messages results={results} />}
          {!running && view === 'plan' && plan && <PlanView plan={plan.plan} rolledBack={plan.rolledBack} onReExplain={(a) => explain(a, plan.sql)} />}
          {!running && current && (
            <>
              <DataGrid fields={current.fields} rows={current.rows} />
              <div className="result-footer">
                <span>
                  {fmtInt(current.rowCount)} ligne{current.rowCount > 1 ? 's' : ''}
                </span>
                {current.truncated && (
                  <span className="warn">Affichage limité à {fmtInt(settings.maxRows)} lignes (Paramètres). L’export de table récupère tout.</span>
                )}
                <span>{formatDuration(current.durationMs)}</span>
                <span style={{ flex: 1 }} />
                <button className="btn" onClick={() => setExporting(current)}>
                  <FileDown /> Exporter
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {exporting && <ExportRowsDialog result={exporting} kind={conn?.kind} onClose={() => setExporting(null)} />}
    </div>
  );
}

function Messages({ results }: { results: QueryResult[] }) {
  if (!results.length)
    return (
      <div className="empty-state">
        <div className="inner">
          Les résultats et messages s’afficheront ici.
          <br />
          <kbd>Ctrl</kbd> + <kbd>Entrée</kbd> exécute l’instruction sous le curseur, <kbd>F5</kbd> exécute tout le script.
        </div>
      </div>
    );
  const total = results.reduce((a, r) => a + r.durationMs, 0);
  return (
    <div className="messages">
      {results.map((r, i) => (
        <div className="msg" key={i}>
          <div className="stmt">{r.statement}</div>
          {r.error ? (
            <div className="err">
              ✕ {r.error}
              {r.errorPosition ? `\n(ligne ${r.errorPosition} de l’instruction)` : ''}
            </div>
          ) : (
            <div>
              <span className="ok">✓ </span>
              {r.fields.length
                ? `${fmtInt(r.rowCount)} ligne(s) renvoyée(s)`
                : r.affectedRows !== undefined
                  ? `${fmtInt(r.affectedRows)} ligne(s) affectée(s)`
                  : `${r.command ?? 'OK'}`}
              <span className="time"> · {formatDuration(r.durationMs)}</span>
            </div>
          )}
        </div>
      ))}
      <div className="msg time">
        {results.length} instruction(s) · {formatDuration(total)}
      </div>
    </div>
  );
}

function ExportRowsDialog({ result, kind, onClose }: { result: QueryResult; kind?: string; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const go = async () => {
    const f = FORMATS.find((x) => x.id === format)!;
    const file = await api.saveDialog({ defaultPath: `resultat.${f.ext}`, filters: [{ name: f.label, extensions: [f.ext] }] });
    if (!file) return;
    try {
      const n = await api.exportRows(file, format, result.fields, result.rows, 'resultat', true, kind);
      toast(`${fmtInt(n)} lignes exportées`, 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal
      title="Exporter le résultat"
      onClose={onClose}
      footer={
        <>
          <button className="btn outline" onClick={onClose}>
            Annuler
          </button>
          <button className="btn primary" onClick={go}>
            Choisir le fichier et exporter
          </button>
        </>
      }
    >
      <p>
        {fmtInt(result.rows.length)} lignes affichées seront exportées.
        {result.truncated ? ' Le résultat a été tronqué : pour tout exporter, utilise l’export de table ou augmente la limite.' : ''}
      </p>
      <div className="seg">
        {FORMATS.map((f) => (
          <button key={f.id} className={format === f.id ? 'active' : ''} onClick={() => setFormat(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
    </Modal>
  );
}
