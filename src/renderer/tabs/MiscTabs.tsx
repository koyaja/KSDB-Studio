import { CircleSlash, FileCode, FolderOpen, Plus, RefreshCw, Trash2, XOctagon , Loader2} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { HistoryEntry, ProcessInfo, Settings, ThemeId, ToolStatus } from '../../shared/types';
import { DEFAULT_SCHEDULE, THEMES } from '../themes';
import { checkUpdatesNow } from '../components/Updates';
import { api } from '../api';
import { Field, fmtInt, formatDuration } from '../components/ui';
import { confirmDialog, newQueryTab, refreshConnections, saveSettings, setState, Tab, toast, useApp } from '../state';

// ---------- Processus ----------
export function ProcessesTab({ tab, active }: { tab: Extract<Tab, { kind: 'processes' }>; active: boolean }) {
  const [list, setList] = useState<ProcessInfo[]>([]);
  const [auto, setAuto] = useState(false);
  const [hideIdle, setHideIdle] = useState(true);
  const load = () => api.processes(tab.connectionId).then(setList).catch((e) => toast(e.message, 'error'));
  useEffect(() => {
    if (active) load();
  }, [active]);
  useEffect(() => {
    if (!auto || !active) return;
    const h = setInterval(load, 3000);
    return () => clearInterval(h);
  }, [auto, active]);
  const kill = async (p: ProcessInfo, mode: 'cancel' | 'terminate') => {
    if (mode === 'terminate' && !(await confirmDialog(`Terminer la session ${p.id} ?`, `${p.user}@${p.client}\n${p.query.slice(0, 300)}`, { danger: true, confirmLabel: 'Terminer' }))) return;
    try {
      await api.kill(tab.connectionId, p.id, mode);
      toast(mode === 'cancel' ? 'Requête annulée' : 'Session terminée', 'success');
      load();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const shown = list.filter((p) => !hideIdle || !/^(idle|Sleep)/i.test(p.state));
  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="toolbar">
        <button className="btn" onClick={load}>
          <RefreshCw /> Actualiser
        </button>
        <label className="check" style={{ marginLeft: 10 }}>
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Toutes les 3 s
        </label>
        <label className="check" style={{ marginLeft: 14 }}>
          <input type="checkbox" checked={hideIdle} onChange={(e) => setHideIdle(e.target.checked)} /> Masquer les sessions inactives
        </label>
        <span className="grow" />
        <span className="hint">
          {shown.length} / {list.length} sessions
        </span>
      </div>
      <div className="page" style={{ padding: 0 }}>
        <table className="plain">
          <thead>
            <tr>
              <th>ID</th>
              <th>Utilisateur</th>
              <th>Base</th>
              <th>Client</th>
              <th>État</th>
              <th>Durée</th>
              <th>Requête</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td className="mono">{p.id}</td>
                <td>{p.user}</td>
                <td>{p.database}</td>
                <td className="mono">{p.client}</td>
                <td>{p.state}</td>
                <td className="mono" style={{ color: (p.durationSec ?? 0) > 30 ? 'var(--ochre)' : undefined }}>
                  {p.durationSec !== null ? formatDuration(p.durationSec * 1000) : ''}
                </td>
                <td className="mono" style={{ maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={p.query}>
                  {p.query}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <button className="btn icon" title="Annuler la requête" onClick={() => kill(p, 'cancel')}>
                    <CircleSlash />
                  </button>
                  <button className="btn icon" title="Terminer la session" onClick={() => kill(p, 'terminate')}>
                    <XOctagon />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Historique ----------
export function HistoryTab({ active }: { active: boolean }) {
  const [list, setList] = useState<HistoryEntry[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (active) api.history().then(setList).catch(() => {});
  }, [active]);
  const shown = useMemo(() => (q ? list.filter((h) => h.sql.toLowerCase().includes(q.toLowerCase())) : list).slice(0, 400), [list, q]);
  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="toolbar">
        <input className="input" style={{ width: 360 }} placeholder="Rechercher dans l’historique" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="grow" />
        <span className="hint">Double-clic : rouvrir dans un nouvel onglet</span>
        <button
          className="btn"
          onClick={async () => {
            if (await confirmDialog('Effacer tout l’historique ?', undefined, { danger: true, confirmLabel: 'Effacer' })) {
              await api.clearHistory();
              setList([]);
            }
          }}
        >
          <Trash2 /> Effacer
        </button>
      </div>
      <div className="history-list">
        {!shown.length && <div className="empty-state">Aucune requête pour l’instant.</div>}
        {shown.map((h) => (
          <div key={h.id} className="history-item" onDoubleClick={() => newQueryTab(h.connectionId, h.database, h.sql)}>
            <div className="h">
              <span>{new Date(h.at).toLocaleString('fr-FR')}</span>
              <span>
                {h.connectionName} {h.database && `· ${h.database}`}
              </span>
              <span>{formatDuration(h.durationMs)}</span>
              {!h.ok && <span className="bad">erreur</span>}
            </div>
            <pre>{h.sql}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Paramètres ----------
export function SettingsTab({ active }: { active: boolean }) {
  const settings = useApp((s) => s.settings);
  const appInfo = useApp((s) => s.appInfo);
  const checking = useApp((s) => s.updateChecking);
  const [draft, setDraft] = useState<Settings>(settings);
  const [tools, setTools] = useState<ToolStatus[]>([]);
  useEffect(() => setDraft(settings), [settings]);
  const loadTools = () => api.tools().then(setTools).catch(() => {});
  useEffect(() => {
    if (active) loadTools();
  }, [active]);
  const themeSchedule = draft.themeSchedule ?? DEFAULT_SCHEDULE;
  const set = (p: Partial<Settings>) => {
    const next = { ...draft, ...p };
    setDraft(next);
    saveSettings(next);
  };
  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="page" style={{ maxWidth: 820 }}>
        <h2>Thème</h2>
        <p className="lead">Pour le confort des yeux : « Papier » le jour, « Nuit douce » le soir. Le mode « Selon l’heure » bascule tout seul.</p>
        <div className="seg" style={{ marginBottom: 14 }}>
          {(
            [
              ['fixed', 'Thème fixe'],
              ['schedule', 'Selon l’heure'],
              ['system', 'Suivre le système'],
            ] as const
          ).map(([k, l]) => {
            const mode = draft.theme === 'schedule' || draft.theme === 'system' ? draft.theme : 'fixed';
            return (
              <button
                key={k}
                className={mode === k ? 'active' : ''}
                onClick={() =>
                  k === 'fixed'
                    ? set({ theme: (themeSchedule.day as ThemeId) })
                    : set({ theme: k, themeSchedule })
                }
              >
                {l}
              </button>
            );
          })}
        </div>
        {draft.theme !== 'schedule' && draft.theme !== 'system' ? (
          <ThemeCards value={draft.theme} onPick={(id) => set({ theme: id })} />
        ) : (
          <>
            <div className="form-row" style={{ alignItems: 'center', marginBottom: 8 }}>
              <b style={{ fontWeight: 500 }}>Jour</b>
              {draft.theme === 'schedule' && (
                <span className="hint">
                  de{' '}
                  <input className="input small" type="time" value={themeSchedule.to} onChange={(e) => set({ themeSchedule: { ...themeSchedule, to: e.target.value } })} /> à{' '}
                  <input className="input small" type="time" value={themeSchedule.from} onChange={(e) => set({ themeSchedule: { ...themeSchedule, from: e.target.value } })} />
                </span>
              )}
              {draft.theme === 'system' && <span className="hint">quand le système est en mode clair</span>}
            </div>
            <ThemeCards value={themeSchedule.day} onPick={(id) => set({ themeSchedule: { ...themeSchedule, day: id } })} />
            <div className="form-row" style={{ alignItems: 'center', margin: '16px 0 8px' }}>
              <b style={{ fontWeight: 500 }}>Nuit</b>
              <span className="hint">{draft.theme === 'schedule' ? `de ${themeSchedule.from} à ${themeSchedule.to}` : 'quand le système est en mode sombre'}</span>
            </div>
            <ThemeCards value={themeSchedule.night} onPick={(id) => set({ themeSchedule: { ...themeSchedule, night: id } })} />
          </>
        )}

        <h2>Affichage</h2>
        <div className="form-grid">
          <Field label="Taille de police de l’éditeur" hint="Ctrl + et Ctrl − agrandissent toute l’interface">
            <input className="input" type="number" min={10} max={24} value={draft.editorFontSize} onChange={(e) => set({ editorFontSize: Number(e.target.value) || 13 })} style={{ width: 90 }} />
          </Field>
          <label className="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={draft.uppercaseKeywords} onChange={(e) => set({ uppercaseKeywords: e.target.checked })} />
            Mots-clés SQL en majuscules
          </label>
        </div>
        <h2>Résultats</h2>
        <div className="form-grid">
          <Field label="Lignes max. par résultat de requête" hint="Au-delà, l’affichage est tronqué ; l’export de table récupère tout.">
            <input className="input" type="number" min={100} step={500} value={draft.maxRows} onChange={(e) => set({ maxRows: Number(e.target.value) || 2000 })} />
          </Field>
          <Field label="Lignes par page (données de table)">
            <input className="input" type="number" min={10} step={50} value={draft.pageSize} onChange={(e) => set({ pageSize: Number(e.target.value) || 200 })} />
          </Field>
        </div>
        <h2>Outils de sauvegarde</h2>
        <p className="lead">Détectés automatiquement dans le PATH et les dossiers d’installation habituels. Indique un chemin pour forcer une version.</p>
        <table className="plain">
          <tbody>
            {tools.map((t) => (
              <tr key={t.name}>
                <td className="mono" style={{ width: 110 }}>
                  {t.name}
                </td>
                <td style={{ width: '45%' }}>
                  <div className="form-row">
                    <input
                      className="input mono small"
                      style={{ flex: 1 }}
                      placeholder={t.path ?? 'non trouvé'}
                      value={draft.binaries[t.name] ?? ''}
                      onChange={(e) => set({ binaries: { ...draft.binaries, [t.name]: e.target.value || undefined } })}
                      onBlur={loadTools}
                    />
                    <button
                      className="btn icon"
                      title="Choisir l’exécutable"
                      onClick={async () => {
                        const f = await api.openDialog({ properties: ['openFile'] });
                        if (f?.[0]) {
                          set({ binaries: { ...draft.binaries, [t.name]: f[0] } });
                          setTimeout(loadTools, 200);
                        }
                      }}
                    >
                      <FolderOpen />
                    </button>
                  </div>
                </td>
                <td className="hint">{t.version ?? <span style={{ color: 'var(--danger)' }}>introuvable</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <h2>Mises à jour</h2>
        <div className="form-row" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <span>
            Version installée : <b>{appInfo?.version ?? '…'}</b>
          </span>
          <button className="btn outline" disabled={checking} onClick={() => checkUpdatesNow()}>
            {checking ? <Loader2 className="spin" /> : <RefreshCw />} Rechercher maintenant
          </button>
          <button className="btn" onClick={() => setState({ aboutOpen: true })}>
            À propos
          </button>
        </div>
        <label className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" checked={draft.checkUpdates !== false} onChange={(e) => set({ checkUpdates: e.target.checked })} />
          Me prévenir quand une nouvelle version est publiée (vérifié au démarrage puis toutes les 6 h)
        </label>
        {draft.skippedVersion && (
          <p className="hint" style={{ marginTop: 6 }}>
            Version ignorée : {draft.skippedVersion}.{' '}
            <a href="#" style={{ color: 'var(--accent)' }} onClick={(e) => (e.preventDefault(), set({ skippedVersion: undefined }))}>
              Annuler
            </a>
          </p>
        )}

        <h2>Connexions</h2>
        <div className="form-row">
          <button
            className="btn outline"
            onClick={async () => {
              const f = await api.openDialog({ properties: ['openFile'], filters: [{ name: 'Navicat (.ncx)', extensions: ['ncx'] }] });
              if (!f?.[0]) return;
              try {
                const r = await api.importNavicat(f[0]);
                await refreshConnections();
                toast(`${r.imported} connexion(s) importée(s)${r.skipped.length ? `, ${r.skipped.length} ignorée(s) (${[...new Set(r.skipped.map((s) => s.type))].join(', ')})` : ''}`, 'success');
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }}
          >
            <Plus /> Importer depuis Navicat (.ncx)
          </button>
          <button
            className="btn outline"
            onClick={async () => {
              const f = await api.openDialog({ properties: ['openFile'], filters: [{ name: 'Connexions KSDB', extensions: ['json'] }] });
              if (!f?.[0]) return;
              try {
                const n = await api.importConnections(f[0]);
                await refreshConnections();
                toast(`${n} connexion(s) importée(s)`, 'success');
              } catch (e) {
                toast((e as Error).message, 'error');
              }
            }}
          >
            <Plus /> Importer un fichier KSDB
          </button>
          <ExportAllButton />
        </div>
      </div>
    </div>
  );
}

function ExportAllButton() {
  const connections = useApp((s) => s.connections);
  return (
    <button
      className="btn outline"
      disabled={!connections.length}
      onClick={async () => {
        const file = await api.saveDialog({ defaultPath: 'connexions.ksdb.json', filters: [{ name: 'Connexions KSDB', extensions: ['json'] }] });
        if (!file) return;
        const withPw = await confirmDialog('Inclure les mots de passe ?', 'Ils seront chiffrés de façon réversible dans le fichier : garde-le en lieu sûr.', { confirmLabel: 'Inclure' });
        const n = await api.exportConnections(file, connections.map((c) => c.id), withPw);
        toast(`${fmtInt(n)} connexion(s) exportée(s)`, 'success');
      }}
    >
      <FileCode /> Exporter toutes les connexions
    </button>
  );
}

export const openSettings = () => setState((s) => ({ tabs: s.tabs.some((t) => t.kind === 'settings') ? s.tabs : [...s.tabs, { id: 'settings', kind: 'settings' }], activeTab: s.tabs.find((t) => t.kind === 'settings')?.id ?? 'settings' }));

function ThemeCards({ value, onPick }: { value: ThemeId; onPick: (id: ThemeId) => void }) {
  return (
    <div className="theme-cards" role="radiogroup">
      {THEMES.map((t) => {
        const [bg, panel, text, accent] = t.preview;
        return (
          <button key={t.id} role="radio" aria-checked={value === t.id} className={`theme-card ${value === t.id ? 'active' : ''}`} onClick={() => onPick(t.id)}>
            <div className="mini" style={{ background: bg }}>
              <div className="side" style={{ background: panel }}>
                <i style={{ background: accent, width: '70%' }} />
                <i style={{ background: text, opacity: 0.45, width: '85%' }} />
                <i style={{ background: text, opacity: 0.45, width: '60%' }} />
              </div>
              <div className="body">
                <i style={{ background: accent, width: '40%' }} />
                <i style={{ background: text, opacity: 0.7, width: '90%' }} />
                <i style={{ background: text, opacity: 0.7, width: '75%' }} />
                <i style={{ background: text, opacity: 0.35, width: '55%' }} />
              </div>
            </div>
            <b>{t.label}</b>
            <small>{t.description}</small>
          </button>
        );
      })}
    </div>
  );
}
