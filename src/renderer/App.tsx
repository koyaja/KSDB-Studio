import {
  Activity,
  DatabaseZap,
  FileCode,
  FileInput,
  FilePlus2,
  FileUp,
  History,
  Moon,
  Pencil,
  Plus,
  Settings2,
  Shield,
  Clock3,
  Monitor,
  Network,
  Sun,
  Table2,
  Upload,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { ConnectionDialog } from './components/ConnectionDialog';
import { Sidebar } from './components/Sidebar';
import { VpnManager } from './components/VpnManager';
import { AboutDialog, UpdateDialog, UpdatePill } from './components/Updates';
import { DEFAULT_SCHEDULE, resolveTheme, THEMES, themeInfo } from './themes';
import { ContextMenuHost, DialogHost, Logo, openMenu, Toasts, useDrag } from './components/ui';
import { BackupTab } from './tabs/BackupTab';
import { DesignerTab } from './tabs/DesignerTab';
import { ImportTab } from './tabs/ImportTab';
import { HistoryTab, openSettings, ProcessesTab, SettingsTab } from './tabs/MiscTabs';
import { QueryTab } from './tabs/QueryTab';
import { ErdTab } from './tabs/ErdTab';
import { TableTab } from './tabs/TableTab';
import {
  closeTab,
  connectionById,
  getState,
  newQueryTab,
  openTab,
  promptDialog,
  onVpnEvent,
  refreshConnections,
  refreshVpns,
  restoreWorkspace,
  saveSettings,
  setState,
  Tab,
  toast,
  updateTab,
  useApp,
} from './state';

function tabTitle(t: Tab): string {
  switch (t.kind) {
    case 'query':
      return t.title;
    case 'table':
      return t.table;
    case 'designer':
      return t.table ? `${t.table} (structure)` : 'Nouvelle table';
    case 'backup':
      return `${t.mode === 'dump' ? 'Sauvegarde' : 'Restauration'} ${t.database}`;
    case 'import':
      return `Import → ${t.table}`;
    case 'processes':
      return `Processus · ${connectionById(t.connectionId)?.name ?? ''}`;
    case 'erd':
      return `ERD ${t.schema !== t.database ? `${t.database}.${t.schema}` : t.database}`;
    case 'history':
      return 'Historique';
    case 'settings':
      return 'Paramètres';
  }
}

function tabIcon(t: Tab) {
  const p = { className: 'ico' };
  switch (t.kind) {
    case 'query':
      return <FileCode {...p} />;
    case 'table':
      return <Table2 {...p} style={{ color: 'var(--accent)' }} />;
    case 'designer':
      return <Pencil {...p} />;
    case 'backup':
      return t.mode === 'dump' ? <FileUp {...p} /> : <Upload {...p} />;
    case 'import':
      return <FileInput {...p} />;
    case 'processes':
      return <Activity {...p} />;
    case 'erd':
      return <Network {...p} style={{ color: 'var(--accent)' }} />;
    case 'history':
      return <History {...p} />;
    case 'settings':
      return <Settings2 {...p} />;
  }
}

const tabConn = (t: Tab) => ('connectionId' in t ? t.connectionId : null);

export function App() {
  const tabs = useApp((s) => s.tabs);
  const activeTab = useApp((s) => s.activeTab);
  const settings = useApp((s) => s.settings);
  const themeResolved = useApp((s) => s.themeResolved);
  const connections = useApp((s) => s.connections);
  const appInfo = useApp((s) => s.appInfo);
  const [sidebarW, setSidebarW] = useState(290);
  const dragStart = useRef(290);

  // Chargement initial
  useEffect(() => {
    (async () => {
      try {
        const s = await api.settings();
        setState({ settings: s });
        await refreshConnections();
        await refreshVpns().catch(() => {});
        api.appInfo().then((appInfo) => setState({ appInfo })).catch(() => {});
        api.lastUpdate().then((u) => u && setState({ update: u })).catch(() => {});
        await restoreWorkspace();
      } catch (e) {
        toast((e as Error).message, 'error');
      }
    })();
  }, []);

  // Notifications de mise à jour (vérification automatique côté process principal)
  useEffect(
    () =>
      window.ksdb.onUpdate((ev) => {
        if ('progress' in ev) {
          setState((s) => ({ download: { ...s.download, state: 'downloading', done: ev.progress.done, total: ev.progress.total } }));
          return;
        }
        const { open, ...info } = ev;
        setState({ update: info, updateCheckedAt: Date.now() });
        if (open) setState({ updateOpen: true });
        else if (info.available && getState().settings.skippedVersion !== info.latest)
          toast(`KSDB Studio ${info.latest} est disponible. Clique sur « Mise à jour » en haut.`, 'info');
      }),
    [],
  );

  // Événements VPN + rafraîchissement périodique de l'état des tunnels
  useEffect(() => {
    const off = window.ksdb.onVpn(onVpnEvent);
    const h = setInterval(() => getState().vpns.length && refreshVpns().catch(() => {}), 15000);
    return () => {
      off();
      clearInterval(h);
    };
  }, []);

  // Thème
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const t = resolveTheme(settings, mq.matches);
      document.documentElement.dataset.theme = t;
      if (getState().themeResolved !== t) setState({ themeResolved: t, themeDark: themeInfo(t).dark });
    };
    apply();
    mq.addEventListener('change', apply);
    // mode horaire : vérification chaque minute
    const h = settings.theme === 'schedule' ? setInterval(apply, 60000) : undefined;
    return () => {
      mq.removeEventListener('change', apply);
      if (h) clearInterval(h);
    };
  }, [settings.theme, settings.themeSchedule]);

  // Raccourcis globaux
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 't') {
        e.preventDefault();
        const cur = getState().tabs.find((t) => t.id === getState().activeTab);
        const cid = cur && 'connectionId' in cur ? cur.connectionId : null;
        newQueryTab(cid, cur && 'database' in cur ? cur.database : '');
      }
      if (mod && e.key.toLowerCase() === 'w') {
        e.preventDefault();
        const a = getState().activeTab;
        if (a) closeTab(a);
      }
      if (mod && e.key === 'Tab') {
        e.preventDefault();
        const { tabs: ts, activeTab: a } = getState();
        if (!ts.length) return;
        const i = ts.findIndex((t) => t.id === a);
        const n = (i + (e.shiftKey ? -1 : 1) + ts.length) % ts.length;
        setState({ activeTab: ts[n].id });
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);

  const drag = useDrag((dx) => setSidebarW(Math.min(560, Math.max(200, dragStart.current + dx))));

  const current = tabs.find((t) => t.id === activeTab);
  const currentConn = connectionById(current ? tabConn(current) : null);
  const connected = connections.filter((c) => c.connected).length;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <Logo /> KSDB Studio
        </div>
        <button className="btn" onClick={() => setState({ editingConnection: { id: null } })}>
          <Plus /> Connexion
        </button>
        <button className="btn" onClick={() => newQueryTab(currentConn?.id ?? connections.find((c) => c.connected)?.id ?? null, current && 'database' in current ? current.database : '')}>
          <FilePlus2 /> Requête
        </button>
        <button className="btn" onClick={() => openTab({ id: 'history', kind: 'history' })}>
          <History /> Historique
        </button>
        <VpnTopButton />
        <span className="spacer" />
        <UpdatePill />
        <button
          className="btn icon"
          title={`Thème : ${themeInfo(themeResolved).label}${settings.theme === 'schedule' ? ' (selon l’heure)' : settings.theme === 'system' ? ' (système)' : ''}`}
          onClick={(e) =>
            openMenu(e, [
              ...THEMES.map((t) => ({
                label: `${settings.theme === t.id ? '✓ ' : ''}${t.label}`,
                icon: t.dark ? <Moon /> : <Sun />,
                onClick: () => saveSettings({ ...settings, theme: t.id }),
              })),
              { separator: true },
              {
                label: `${settings.theme === 'schedule' ? '✓ ' : ''}Selon l’heure (jour / nuit)`,
                icon: <Clock3 />,
                onClick: () => saveSettings({ ...settings, theme: 'schedule', themeSchedule: settings.themeSchedule ?? DEFAULT_SCHEDULE }),
              },
              {
                label: `${settings.theme === 'system' ? '✓ ' : ''}Suivre le système`,
                icon: <Monitor />,
                onClick: () => saveSettings({ ...settings, theme: 'system', themeSchedule: settings.themeSchedule ?? DEFAULT_SCHEDULE }),
              },
              { separator: true },
              { label: 'Réglages des thèmes…', icon: <Settings2 />, onClick: openSettings },
            ])
          }
        >
          {themeInfo(themeResolved).dark ? <Moon /> : <Sun />}
        </button>
        <button className="btn icon" title="Paramètres" onClick={openSettings}>
          <Settings2 />
        </button>
      </header>

      <div className="workspace" style={{ ['--sidebar-w' as string]: `${sidebarW}px` }}>
        <Sidebar />
        <div
          className="splitter"
          onMouseDown={(e) => {
            dragStart.current = sidebarW;
            drag(e);
          }}
        />
        <main className="main">
          {tabs.length > 0 && (
            <nav className="tabbar" role="tablist">
              {tabs.map((t) => {
                const c = connectionById(tabConn(t));
                return (
                  <div
                    key={t.id}
                    role="tab"
                    aria-selected={t.id === activeTab}
                    className={`tab ${t.id === activeTab ? 'active' : ''}`}
                    onMouseDown={(e) => {
                      if (e.button === 1) {
                        e.preventDefault();
                        closeTab(t.id);
                      } else if (e.button === 0) setState({ activeTab: t.id });
                    }}
                    onContextMenu={(e) =>
                      openMenu(e, [
                        { label: 'Fermer', onClick: () => closeTab(t.id) },
                        { label: 'Fermer les autres', onClick: () => getState().tabs.filter((x) => x.id !== t.id).forEach((x) => closeTab(x.id)) },
                        { label: 'Fermer tout', onClick: () => getState().tabs.forEach((x) => closeTab(x.id)) },
                        ...(t.kind === 'query'
                          ? [
                              { separator: true },
                              {
                                label: 'Renommer',
                                onClick: async () => {
                                  const n = await promptDialog('Renommer l’onglet', { defaultValue: t.title });
                                  if (n) updateTab(t.id, { title: n });
                                },
                              },
                            ]
                          : []),
                      ])
                    }
                    title={c ? `${c.name}${'database' in t && t.database ? ' · ' + t.database : ''}` : undefined}
                  >
                    {c && <span className="conn-band" style={{ background: c.color || 'var(--accent)' }} />}
                    {tabIcon(t)}
                    <span className="t">{tabTitle(t)}</span>
                    {t.kind === 'query' && t.dirty ? <span className="dirty" title="Non enregistré" /> : null}
                    <button
                      className="x"
                      aria-label="Fermer l’onglet"
                      onMouseDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                    >
                      <X />
                    </button>
                  </div>
                );
              })}
            </nav>
          )}
          <div className="tab-content">
            {tabs.length === 0 && <Welcome />}
            {tabs.map((t) => {
              const active = t.id === activeTab;
              switch (t.kind) {
                case 'query':
                  return <QueryTab key={t.id} tab={t} active={active} />;
                case 'table':
                  return <TableTab key={t.id} tab={t} active={active} />;
                case 'designer':
                  return <DesignerTab key={t.id} tab={t} active={active} />;
                case 'backup':
                  return <BackupTab key={t.id} tab={t} active={active} />;
                case 'import':
                  return <ImportTab key={t.id} tab={t} active={active} />;
                case 'erd':
                  return <ErdTab key={t.id} tab={t} active={active} />;
                case 'processes':
                  return <ProcessesTab key={t.id} tab={t} active={active} />;
                case 'history':
                  return <HistoryTab key={t.id} active={active} />;
                case 'settings':
                  return <SettingsTab key={t.id} active={active} />;
              }
            })}
          </div>
        </main>
      </div>

      <footer className="statusbar">
        {currentConn ? (
          <>
            <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: currentConn.connected ? 'var(--ok)' : 'var(--muted)' }} />
              {currentConn.name}
            </span>
            <span>
              {currentConn.user}@{currentConn.host}:{currentConn.port}
              {currentConn.ssh.enabled ? ' via SSH' : ''}
            </span>
            {current && 'database' in current && current.database && <span>base : {current.database}</span>}
            {currentConn.readOnly && <span style={{ color: 'var(--ochre)' }}>lecture seule</span>}
            {currentConn.production && <span style={{ color: 'var(--danger)' }}>production</span>}
          </>
        ) : (
          <span>{connections.length} connexion(s) enregistrée(s)</span>
        )}
        <span style={{ marginLeft: 'auto' }}>{connected ? `${connected} connectée(s)` : 'Aucune connexion active'}</span>
        <button className="status-version" onClick={() => setState({ aboutOpen: true })} title="À propos de KSDB Studio">
          v{appInfo?.version ?? '…'}
        </button>
      </footer>

      <ConnectionDialog />
      <VpnManager />
      <UpdateDialog />
      <AboutDialog />
      <DialogHost />
      <ContextMenuHost />
      <Toasts />
    </div>
  );
}

function Welcome() {
  const connections = useApp((s) => s.connections);
  const appVersion = useApp((s) => s.appInfo?.version);
  return (
    <div className="welcome">
      <h1>
        KSDB Studio <span className="hint" style={{ fontSize: 14, fontWeight: 400, marginLeft: 6 }}>{appVersion ? `v${appVersion}` : ''}</span>
      </h1>
      <p className="lede">
        PostgreSQL, MySQL et MariaDB au même endroit : connexions (y compris via SSH), éditeur SQL, édition des données, structure, import/export et
        sauvegardes.
      </p>
      <div className="welcome-actions">
        <button onClick={() => setState({ editingConnection: { id: null } })}>
          <b>
            <Plus /> Nouvelle connexion
          </b>
          <small>PostgreSQL, MySQL ou MariaDB, en direct ou par tunnel SSH</small>
        </button>
        <button
          onClick={async () => {
            const f = await api.openDialog({ properties: ['openFile'], filters: [{ name: 'Navicat (.ncx)', extensions: ['ncx'] }] });
            if (!f?.[0]) return;
            try {
              const r = await api.importNavicat(f[0]);
              await refreshConnections();
              toast(`${r.imported} connexion(s) importée(s) depuis Navicat${r.skipped.length ? ` (${r.skipped.length} non prises en charge)` : ''}`, 'success');
            } catch (e) {
              toast((e as Error).message, 'error');
            }
          }}
        >
          <b>
            <DatabaseZap /> Importer depuis Navicat
          </b>
          <small>Fichier .ncx exporté par Fichier → Exporter les connexions</small>
        </button>
        <button onClick={() => newQueryTab(connections.find((c) => c.connected)?.id ?? connections[0]?.id ?? null)}>
          <b>
            <FilePlus2 /> Nouvelle requête
          </b>
          <small>Ctrl+T depuis n’importe où</small>
        </button>
        <button onClick={openSettings}>
          <b>
            <Settings2 /> Paramètres
          </b>
          <small>Thème, limites d’affichage, chemins de pg_dump / mysqldump</small>
        </button>
      </div>
      <div className="shortcuts">
        <h2>Raccourcis</h2>
        <table>
          <tbody>
            {[
              [['Ctrl', 'Entrée'], 'Exécuter la sélection ou l’instruction sous le curseur'],
              [['F5'], 'Exécuter tout le script'],
              [['Ctrl', 'E'], 'Plan d’exécution (EXPLAIN)'],
              [['Ctrl', 'Maj', 'F'], 'Formater le SQL'],
              [['Ctrl', 'Espace'], 'Autocomplétion (tables, colonnes, mots-clés)'],
              [['Ctrl', 'S'], 'Enregistrer le script / les modifications de données'],
              [['Ctrl', 'T'], 'Nouvel onglet de requête'],
              [['Ctrl', 'W'], 'Fermer l’onglet'],
              [['Entrée'], 'Éditer la cellule (grille de données)'],
              [['Ctrl', 'Suppr'], 'Mettre la cellule à NULL'],
              [['Ctrl', 'Maj', 'C'], 'Copier la sélection avec les en-têtes'],
            ].map(([keys, label], i) => (
              <tr key={i}>
                <td>
                  {(keys as string[]).map((k, j) => (
                    <span key={j}>
                      {j > 0 && ' + '}
                      <kbd>{k}</kbd>
                    </span>
                  ))}
                </td>
                <td>{label as string}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function VpnTopButton() {
  const vpns = useApp((s) => s.vpns);
  const active = vpns.filter((v) => v.status.state === 'up');
  return (
    <button
      className="btn vpn-top"
      title={active.length ? `VPN actifs : ${active.map((v) => v.profile.name).join(', ')}` : 'Gérer les VPN WireGuard'}
      onClick={() => setState({ vpnManagerOpen: true })}
    >
      <Shield /> VPN{active.length ? ` (${active.length})` : ''}
      {active.length > 0 && <span className="badge" />}
    </button>
  );
}
