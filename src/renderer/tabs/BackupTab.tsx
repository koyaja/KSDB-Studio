import { FolderOpen, Play, Square } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { JobEvent, ToolStatus } from '../../shared/types';
import { api } from '../api';
import { Field } from '../components/ui';
import { trackJob } from '../jobs';
import { bumpTree, confirmDialog, connectionById, openTab, Tab, toast, updateTab, useApp } from '../state';

type BTab = Extract<Tab, { kind: 'backup' }>;

interface LogLine {
  t: 'l' | 'e' | 'd';
  m: string;
}

function stamp() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

export function BackupTab({ tab, active }: { tab: BTab; active: boolean }) {
  const conn = useApp((s) => s.connections.find((c) => c.id === tab.connectionId));
  const kind = conn?.kind ?? 'postgres';
  const [dbs, setDbs] = useState<string[]>([]);
  const [tools, setTools] = useState<ToolStatus[]>([]);
  const [file, setFile] = useState('');
  const [format, setFormat] = useState<'plain' | 'custom'>(kind === 'postgres' ? 'custom' : 'plain');
  const [content, setContent] = useState<'all' | 'schema' | 'data'>('all');
  const [tables, setTables] = useState((tab.tables ?? []).join(', '));
  const [createDb, setCreateDb] = useState(tab.mode === 'restore');
  const [drop, setDrop] = useState(false);
  const [noOwner, setNoOwner] = useState(true);
  const [jobs, setJobs] = useState(4);
  const [log, setLog] = useState<LogLine[]>([]);
  const [progress, setProgress] = useState<number | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.databases(tab.connectionId).then(setDbs).catch(() => {});
    api.tools().then(setTools).catch(() => {});
  }, [tab.connectionId]);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [log]);

  const needed = tab.mode === 'dump' ? (kind === 'postgres' ? ['pg_dump'] : ['mysqldump']) : kind === 'postgres' ? ['pg_restore', 'psql'] : ['mysql'];
  const toolInfo = tools.filter((t) => needed.includes(t.name));
  const missing = tools.length > 0 && toolInfo.some((t) => !t.path);

  const pick = async () => {
    if (tab.mode === 'dump') {
      const ext = kind === 'postgres' && format === 'custom' ? 'dump' : 'sql';
      const f = await api.saveDialog({ defaultPath: `${tab.database || 'sauvegarde'}_${stamp()}.${ext}`, filters: [{ name: ext === 'dump' ? 'Archive PostgreSQL' : 'Script SQL', extensions: [ext] }] });
      if (f) setFile(f);
    } else {
      const f = await api.openDialog({
        properties: ['openFile'],
        filters: [
          { name: 'Sauvegardes', extensions: ['sql', 'dump', 'backup', 'tar'] },
          { name: 'Tous les fichiers', extensions: ['*'] },
        ],
      });
      if (f?.[0]) setFile(f[0]);
    }
  };

  const onEvent = (ev: JobEvent) => {
    if (ev.kind === 'log') setLog((l) => [...l.slice(-3000), { t: /error|erreur|fatal/i.test(ev.message ?? '') ? 'e' : 'l', m: ev.message ?? '' }]);
    if (ev.kind === 'progress') setProgress(ev.progress ?? null);
    if (ev.kind === 'done') setLog((l) => [...l, { t: 'd', m: '✓ ' + ev.message }]);
    if (ev.kind === 'error') setLog((l) => [...l, { t: 'e', m: '✕ ' + ev.message }]);
  };

  const start = async () => {
    if (!file) return toast('Choisis d’abord un fichier.', 'error');
    if (!tab.database) return toast('Choisis une base.', 'error');
    if (tab.mode === 'restore' && conn?.production) {
      if (!(await confirmDialog(`Restaurer dans ${tab.database} en production ?`, `Fichier : ${file}`, { danger: true, confirmLabel: 'Restaurer' }))) return;
    }
    setLog([]);
    setProgress(null);
    const tableList = tables
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    const startPromise =
      tab.mode === 'dump'
        ? api.dump({ connectionId: tab.connectionId, database: tab.database, filePath: file, format, content, tables: tableList, createDatabase: createDb, dropObjects: drop, noOwner })
        : api.restore({ connectionId: tab.connectionId, database: tab.database, filePath: file, createDatabase: createDb, clean: drop, noOwner, jobs });
    const t = trackJob(startPromise, onEvent);
    t.jobId.then(setJobId).catch(() => {});
    try {
      const msg = await t.done;
      toast(msg, 'success');
      if (tab.mode === 'restore') bumpTree(tab.connectionId);
      if (tab.mode === 'dump') api.showItem(file).catch(() => {});
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setJobId(null);
      setProgress(null);
    }
  };

  const running = jobId !== null;

  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="page" style={{ maxWidth: 900 }}>
        <h2>{tab.mode === 'dump' ? 'Sauvegarder une base' : 'Restaurer une sauvegarde'}</h2>
        <p className="lead">
          {tab.mode === 'dump'
            ? `Utilise ${kind === 'postgres' ? 'pg_dump' : 'mysqldump'}, l’outil officiel : le fichier produit se restaure partout (Windows, Linux, serveur distant) avec ${kind === 'postgres' ? 'pg_restore ou psql' : 'mysql'}.`
            : `Les fichiers .sql passent par ${kind === 'postgres' ? 'psql' : 'mysql'} ; les archives PostgreSQL (.dump, format custom) par pg_restore.`}
        </p>
        {missing && (
          <div className="banner warn" style={{ borderRadius: 6, marginBottom: 14 }}>
            Outil introuvable : {toolInfo.filter((t) => !t.path).map((t) => t.name).join(', ')}. Installe les outils clients{' '}
            {kind === 'postgres' ? 'PostgreSQL (même version majeure que le serveur, ou plus récente)' : 'MySQL ou MariaDB'} puis indique le chemin dans{' '}
            <a href="#" style={{ color: 'var(--accent)' }} onClick={(e) => (e.preventDefault(), openTab({ id: 'settings', kind: 'settings' }))}>
              Paramètres
            </a>
            .
          </div>
        )}
        <div className="form-grid">
          <Field label="Connexion">
            <input className="input" value={connectionById(tab.connectionId)?.name ?? ''} disabled />
          </Field>
          <Field label={tab.mode === 'dump' ? 'Base à sauvegarder' : 'Base cible'}>
            <input className="input" list={`dbs-${tab.id}`} value={tab.database} onChange={(e) => updateTab(tab.id, { database: e.target.value })} placeholder="nom de la base" />
            <datalist id={`dbs-${tab.id}`}>
              {dbs.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
          </Field>
          <Field label="Fichier" className="full">
            <div className="form-row">
              <input className="input mono" style={{ flex: 1 }} value={file} onChange={(e) => setFile(e.target.value)} />
              <button className="btn outline" onClick={pick}>
                <FolderOpen /> {tab.mode === 'dump' ? 'Enregistrer sous…' : 'Parcourir…'}
              </button>
            </div>
          </Field>

          {tab.mode === 'dump' && (
            <>
              {kind === 'postgres' && (
                <Field label="Format">
                  <div className="seg">
                    <button className={format === 'custom' ? 'active' : ''} onClick={() => setFormat('custom')}>
                      Archive .dump (recommandé)
                    </button>
                    <button className={format === 'plain' ? 'active' : ''} onClick={() => setFormat('plain')}>
                      Script .sql
                    </button>
                  </div>
                </Field>
              )}
              <Field label="Contenu">
                <div className="seg">
                  <button className={content === 'all' ? 'active' : ''} onClick={() => setContent('all')}>
                    Structure + données
                  </button>
                  <button className={content === 'schema' ? 'active' : ''} onClick={() => setContent('schema')}>
                    Structure
                  </button>
                  <button className={content === 'data' ? 'active' : ''} onClick={() => setContent('data')}>
                    Données
                  </button>
                </div>
              </Field>
              <Field label="Tables uniquement (facultatif)" className="full" hint={kind === 'postgres' ? 'schéma.table, séparées par des virgules ; vide = toute la base' : 'séparées par des virgules ; vide = toute la base'}>
                <input className="input mono" value={tables} onChange={(e) => setTables(e.target.value)} />
              </Field>
              <label className="check">
                <input type="checkbox" checked={createDb} onChange={(e) => setCreateDb(e.target.checked)} />
                Inclure CREATE DATABASE
              </label>
              <label className="check">
                <input type="checkbox" checked={drop} onChange={(e) => setDrop(e.target.checked)} />
                Inclure DROP avant chaque objet
              </label>
              {kind === 'postgres' && (
                <label className="check">
                  <input type="checkbox" checked={noOwner} onChange={(e) => setNoOwner(e.target.checked)} />
                  Sans propriétaires ni droits (restauration plus simple ailleurs)
                </label>
              )}
            </>
          )}

          {tab.mode === 'restore' && (
            <>
              <label className="check full">
                <input type="checkbox" checked={createDb} onChange={(e) => setCreateDb(e.target.checked)} />
                Créer la base si elle n’existe pas
              </label>
              {kind === 'postgres' && (
                <>
                  <label className="check">
                    <input type="checkbox" checked={drop} onChange={(e) => setDrop(e.target.checked)} />
                    Supprimer les objets existants avant (archives .dump)
                  </label>
                  <label className="check">
                    <input type="checkbox" checked={noOwner} onChange={(e) => setNoOwner(e.target.checked)} />
                    Ignorer propriétaires et droits
                  </label>
                  <Field label="Tâches parallèles (archives .dump)">
                    <input className="input" type="number" min={1} max={16} value={jobs} onChange={(e) => setJobs(Number(e.target.value))} style={{ width: 90 }} />
                  </Field>
                </>
              )}
            </>
          )}
        </div>

        <div className="form-row" style={{ marginTop: 18 }}>
          <button className="btn primary" disabled={running} onClick={start}>
            <Play /> {tab.mode === 'dump' ? 'Lancer la sauvegarde' : 'Lancer la restauration'}
          </button>
          {running && (
            <button className="btn outline" onClick={() => jobId && api.cancelJob(jobId)}>
              <Square /> Arrêter
            </button>
          )}
          {toolInfo.map((t) => (
            <span key={t.name} className="hint mono" title={t.path ?? ''}>
              {t.version ?? `${t.name} : non trouvé`}
            </span>
          ))}
        </div>
        {running && (
          <div className={`progress ${progress === null ? 'indeterminate' : ''}`}>
            <div style={progress !== null ? { width: `${Math.round(progress * 100)}%` } : undefined} />
          </div>
        )}
        {(log.length > 0 || running) && (
          <div className="joblog" ref={logRef} style={{ marginTop: 12 }}>
            {log.map((l, i) => (
              <div key={i} className={l.t}>
                {l.m}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
