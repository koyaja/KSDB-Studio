import {
  ChevronRight,
  Code2,
  Copy,
  Database,
  Eye,
  FileCode,
  FileDown,
  FileInput,
  FilePlus2,
  Folder,
  FolderTree,
  FunctionSquare,
  Hash,
  Layers,
  Loader2,
  Network,
  GitCompareArrows,
  ArrowRightLeft,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Search,
  ServerCog,
  Shield,
  ShieldCheck,
  Play,
  Square,
  Table2,
  TerminalSquare,
  Trash2,
  Unplug,
  Upload,
  Zap,
} from 'lucide-react';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import type { DbObject, ObjectType } from '../../shared/types';
import { copyText, qualified, quoteIdent, runAdmin } from '../actions';
import { api, ListedConnection } from '../api';
import {
  bumpTree,
  confirmDialog,
  ensureConnected,
  getState,
  newQueryTab,
  openTab,
  promptDialog,
  refreshConnections,
  refreshVpns,
  setState,
  startVpn,
  stopVpn,
  toast,
  uid,
  useApp,
  vpnById,
} from '../state';
import { GroupVpnDialog, VPN_STATE_LABEL, VpnDot, vpnStateOf } from './VpnManager';
import { ExportTableDialog, ExportTarget } from './ExportDialog';
import { MenuItem, openMenu } from './ui';

const expanded = new Set<string>();
let filterText = '';

const CATEGORIES: { type: ObjectType; label: string; icon: ReactNode }[] = [
  { type: 'table', label: 'Tables', icon: <Table2 className="ico ico-table" /> },
  { type: 'view', label: 'Vues', icon: <Eye className="ico ico-view" /> },
  { type: 'matview', label: 'Vues matérialisées', icon: <Layers className="ico ico-view" /> },
  { type: 'function', label: 'Fonctions', icon: <FunctionSquare className="ico ico-fn" /> },
  { type: 'procedure', label: 'Procédures', icon: <TerminalSquare className="ico ico-fn" /> },
  { type: 'sequence', label: 'Séquences', icon: <Hash className="ico ico-fn" /> },
  { type: 'trigger', label: 'Triggers', icon: <Zap className="ico ico-fn" /> },
];

let exportSetter: ((t: ExportTarget | null) => void) | null = null;
export function openExport(t: ExportTarget) {
  exportSetter?.(t);
}

export function Sidebar() {
  const connections = useApp((s) => s.connections);
  const [filter, setFilter] = useState('');
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  const [groupVpn, setGroupVpn] = useState<string | null>(null);
  exportSetter = setExportTarget;
  filterText = filter.trim().toLowerCase();

  const grouped = useMemo(() => {
    const map = new Map<string, ListedConnection[]>();
    for (const c of connections) {
      const g = c.group?.trim() || '';
      map.set(g, [...(map.get(g) ?? []), c]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)));
  }, [connections]);

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div style={{ position: 'relative', flex: 1, display: 'flex' }}>
          <input className="input" placeholder="Filtrer les objets ouverts" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ paddingLeft: 28 }} />
          <Search style={{ position: 'absolute', left: 8, top: 7, width: 14, height: 14, color: 'var(--muted)' }} />
        </div>
        <button className="btn icon" title="Nouvelle connexion" onClick={() => setState({ editingConnection: { id: null } })}>
          <Plus />
        </button>
      </div>
      <div className="tree" role="tree">
        {connections.length === 0 && (
          <div className="sidebar-empty">
            <p>Aucune connexion pour l’instant.</p>
            <button className="btn primary" onClick={() => setState({ editingConnection: { id: null } })}>
              <Plus /> Nouvelle connexion
            </button>
          </div>
        )}
        {grouped.map(([group, list]) => (
          <div key={group || '_'}>
            {group && <GroupHeader group={group} onPickVpn={() => setGroupVpn(group)} />}
            {list
              .filter((c) => !filterText || c.connected || c.name.toLowerCase().includes(filterText))
              .map((c) => (
                <ConnectionNode key={c.id} conn={c} />
              ))}
          </div>
        ))}
      </div>
      {exportTarget && <ExportTableDialog target={exportTarget} onClose={() => setExportTarget(null)} />}
      {groupVpn && <GroupVpnDialog group={groupVpn} onClose={() => setGroupVpn(null)} />}
    </aside>
  );
}

function openCompare(connectionId: string, database: string, schema: string) {
  openTab({
    id: uid(),
    kind: 'compare',
    source: { connectionId, database, schema },
    target: { connectionId, database: '', schema: '' },
  });
}

export function openUsers(connectionId: string, database: string) {
  const existing = getState().tabs.find((t) => t.kind === 'users' && t.connectionId === connectionId);
  if (existing) return setState({ activeTab: existing.id });
  openTab({ id: uid(), kind: 'users', connectionId, database });
}

export function openTransfer(connectionId: string, database: string, schema: string, tables?: string[]) {
  openTab({
    id: uid(),
    kind: 'transfer',
    source: { connectionId, database, schema },
    target: { connectionId: null, database: '', schema: '' },
    tables,
  });
}

function vpnMenuItems(vpnId: string | null | undefined): MenuItem[] {
  const v = vpnById(vpnId);
  if (!v) return [];
  const st = vpnStateOf(v);
  return st === 'up'
    ? [{ label: `Arrêter le VPN ${v.profile.name}`, icon: <Square />, onClick: () => stopVpn(v.profile.id) }]
    : [{ label: `Démarrer le VPN ${v.profile.name}`, icon: <Play />, onClick: () => startVpn(v.profile.id) }];
}

function GroupHeader({ group, onPickVpn }: { group: string; onPickVpn: () => void }) {
  const vpnId = useApp((s) => s.groups[group]?.vpnId);
  const v = useApp((s) => s.vpns.find((x) => x.profile.id === vpnId));
  const transient = useApp((s) => (vpnId ? s.vpnTransient[vpnId] : undefined));
  const st = vpnStateOf(v, transient);
  return (
    <div
      className="tree-group"
      onContextMenu={(e) =>
        openMenu(e, [
          { label: 'Nouvelle connexion dans ce groupe', icon: <Plus />, onClick: () => setState({ editingConnection: { id: null, group } }) },
          { separator: true },
          { label: v ? 'Changer le VPN du groupe…' : 'Associer un VPN au groupe…', icon: <Shield />, onClick: onPickVpn },
          ...vpnMenuItems(vpnId),
          { separator: true },
          {
            label: 'Renommer le groupe…',
            icon: <Pencil />,
            onClick: async () => {
              const to = await promptDialog('Renommer le groupe', { defaultValue: group, confirmLabel: 'Renommer' });
              if (!to || to === group) return;
              await api.renameGroup(group, to);
              await Promise.all([refreshConnections(), refreshVpns()]);
            },
          },
        ])
      }
    >
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{group}</span>
      {v && (
        <button
          className={`vpn-chip ${st}`}
          title={`VPN ${v.profile.name} : ${VPN_STATE_LABEL[st]}. Clic pour ${st === 'up' ? 'arrêter' : 'démarrer'}.`}
          disabled={st === 'starting' || st === 'stopping'}
          onClick={() => (st === 'up' ? stopVpn(v.profile.id) : startVpn(v.profile.id))}
        >
          <VpnDot state={st} size={6} />
          {v.profile.name}
        </button>
      )}
    </div>
  );
}

function useExpanded(key: string, auto = false): [boolean, (v: boolean) => void] {
  const [open, setOpen] = useState(expanded.has(key) || auto);
  return [
    open,
    (v: boolean) => {
      if (v) expanded.add(key);
      else expanded.delete(key);
      setOpen(v);
    },
  ];
}

function Row(props: {
  depth: number;
  icon: ReactNode;
  label: ReactNode;
  meta?: ReactNode;
  expandable?: boolean;
  open?: boolean;
  onToggle?: () => void;
  onDouble?: () => void;
  onMenu?: (e: React.MouseEvent) => void;
  className?: string;
  title?: string;
}) {
  return (
    <div
      className={`tree-row ${props.className ?? ''}`}
      style={{ paddingLeft: 6 + props.depth * 14 }}
      role="treeitem"
      aria-expanded={props.expandable ? !!props.open : undefined}
      tabIndex={0}
      title={props.title}
      onClick={() => props.expandable && props.onToggle?.()}
      onDoubleClick={props.onDouble}
      onContextMenu={props.onMenu}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (props.onDouble ?? props.onToggle)?.();
        if (e.key === 'ArrowRight' && props.expandable && !props.open) props.onToggle?.();
        if (e.key === 'ArrowLeft' && props.expandable && props.open) props.onToggle?.();
      }}
    >
      {props.expandable ? <ChevronRight className={`twisty ${props.open ? 'open' : ''}`} /> : <span style={{ width: 14, flex: 'none' }} />}
      {props.icon}
      <span className="label">{props.label}</span>
      {props.meta !== undefined && <span className="meta">{props.meta}</span>}
    </div>
  );
}

function Loading({ depth }: { depth: number }) {
  return (
    <div className="tree-row" style={{ paddingLeft: 26 + depth * 14 }}>
      <Loader2 className="ico spin" style={{ color: 'var(--muted)' }} />
      <span className="tree-msg">Chargement…</span>
    </div>
  );
}

function ErrorRow({ depth, text }: { depth: number; text: string }) {
  return (
    <div className="tree-row" style={{ paddingLeft: 26 + depth * 14, height: 'auto' }}>
      <span className="tree-msg err">{text}</span>
    </div>
  );
}

function useLoader<T>(enabled: boolean, version: number, fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setError(null);
    fn()
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [enabled, version]);
  return { data, error };
}

// ---------- Connexion ----------
function ConnectionNode({ conn }: { conn: ListedConnection }) {
  const key = conn.id;
  const [open, setOpen] = useExpanded(key);
  const version = useApp((s) => s.treeVersion[key] ?? 0);
  const [ready, setReady] = useState(conn.connected);
  const [connecting, setConnecting] = useState(false);
  const vpn = useApp((s) => s.vpns.find((v) => v.profile.id === conn.effectiveVpnId));
  const vpnTransient = useApp((s) => (conn.effectiveVpnId ? s.vpnTransient[conn.effectiveVpnId] : undefined));
  const vpnSt = vpnStateOf(vpn, vpnTransient);

  useEffect(() => {
    if (!conn.connected) setReady(false);
  }, [conn.connected]);

  const toggle = async () => {
    if (open) return setOpen(false);
    if (!conn.connected) {
      setConnecting(true);
      const ok = await ensureConnected(conn.id);
      setConnecting(false);
      if (!ok) return;
    }
    setReady(true);
    setOpen(true);
  };

  const { data: dbs, error } = useLoader(open && ready, version, () => api.databases(conn.id));

  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      conn.connected
        ? { label: 'Se déconnecter', icon: <Unplug />, onClick: async () => { await api.disconnect(conn.id); setOpen(false); await refreshConnections(); } }
        : { label: 'Se connecter', icon: <Plug />, onClick: toggle },
      ...vpnMenuItems(conn.effectiveVpnId),
      { label: 'Nouvelle requête', icon: <FileCode />, onClick: () => newQueryTab(conn.id) },
      { label: 'Utilisateurs et droits', icon: <ShieldCheck />, onClick: async () => (await ensureConnected(conn.id)) && openUsers(conn.id, conn.database || (conn.kind === 'postgres' ? 'postgres' : '')) },
      { label: 'Processus du serveur', icon: <ServerCog />, onClick: async () => (await ensureConnected(conn.id)) && openTab({ id: uid(), kind: 'processes', connectionId: conn.id }) },
      { separator: true },
      {
        label: 'Créer une base de données',
        icon: <Database />,
        onClick: async () => {
          if (!(await ensureConnected(conn.id))) return;
          const name = await promptDialog('Nouvelle base de données', { confirmLabel: 'Créer' });
          if (!name) return;
          const sql =
            conn.kind === 'postgres'
              ? `CREATE DATABASE ${quoteIdent('postgres', name)} ENCODING 'UTF8'`
              : `CREATE DATABASE ${quoteIdent('mysql', name)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;
          await runAdmin(conn.id, '', sql, { success: `Base ${name} créée`, refresh: [key] });
        },
      },
      { label: 'Restaurer une sauvegarde…', icon: <Upload />, onClick: async () => (await ensureConnected(conn.id)) && openTab({ id: uid(), kind: 'backup', connectionId: conn.id, database: conn.database || '', mode: 'restore' }) },
      { label: 'Actualiser', icon: <RefreshCw />, onClick: () => bumpTree(key) },
      { separator: true },
      { label: 'Modifier la connexion', icon: <Pencil />, onClick: () => setState({ editingConnection: { id: conn.id } }) },
      {
        label: 'Dupliquer',
        icon: <Copy />,
        onClick: async () => {
          const { hasPassword: _a, hasSshPassword: _b, hasPassphrase: _c, connected: _d, effectiveVpnId: _e, ...rest } = conn;
          // les secrets ne sont pas transmis à l'interface : la copie demandera le mot de passe
          await api.saveConnection({ ...rest, id: '', name: `${conn.name} (copie)` });
          await refreshConnections();
        },
      },
      {
        label: 'Exporter la connexion…',
        icon: <FileDown />,
        onClick: async () => {
          const file = await api.saveDialog({ defaultPath: `${conn.name}.ksdb.json`, filters: [{ name: 'Connexions KSDB', extensions: ['json'] }] });
          if (!file) return;
          const withPw = await confirmDialog('Inclure les mots de passe ?', 'Ils seront chiffrés de façon réversible dans le fichier : garde ce fichier en lieu sûr.', { confirmLabel: 'Inclure' });
          await api.exportConnections(file, [conn.id], withPw);
          toast('Connexion exportée', 'success');
        },
      },
      {
        label: 'Supprimer',
        icon: <Trash2 />,
        danger: true,
        onClick: async () => {
          if (!(await confirmDialog(`Supprimer « ${conn.name} » ?`, 'Seule la connexion enregistrée est supprimée, pas les données du serveur.', { danger: true, confirmLabel: 'Supprimer' }))) return;
          await api.deleteConnection(conn.id);
          await refreshConnections();
        },
      },
    ]);

  return (
    <>
      <Row
        depth={0}
        className="conn"
        expandable
        open={open}
        onToggle={toggle}
        onMenu={menu}
        icon={connecting ? <Loader2 className="ico spin" /> : <span className="conn-dot" style={{ background: conn.color || 'var(--accent)' }} />}
        label={conn.name}
        title={`${conn.flavor === 'mariadb' ? 'MariaDB' : conn.kind === 'postgres' ? 'PostgreSQL' : 'MySQL'} · ${conn.user}@${conn.host}:${conn.port}${conn.ssh.enabled ? ' (via SSH)' : ''}${vpn ? ` · VPN ${vpn.profile.name} (${VPN_STATE_LABEL[vpnSt]})` : ''}`}
        meta={
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {vpn && <ShieldCheck className={`conn-vpn ${vpnSt}`} aria-label={`VPN ${VPN_STATE_LABEL[vpnSt]}`} />}
            {conn.production && <span style={{ color: 'var(--danger)', fontSize: 10.5, fontWeight: 600 }}>PROD</span>}
            {conn.connected && <span className="live" title="Connecté" />}
          </span>
        }
      />
      {open && !dbs && !error && <Loading depth={1} />}
      {open && error && <ErrorRow depth={1} text={error} />}
      {open && dbs?.map((db) => <DatabaseNode key={db} conn={conn} db={db} />)}
    </>
  );
}

// ---------- Base ----------
function DatabaseNode({ conn, db }: { conn: ListedConnection; db: string }) {
  const key = `${conn.id}|${db}`;
  const [open, setOpen] = useExpanded(key, false);
  const version = useApp((s) => s.treeVersion[key] ?? 0);
  const { data: schemas, error } = useLoader(open, version, () => api.schemas(conn.id, db));
  const isMy = conn.kind === 'mysql';

  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: 'Nouvelle requête', icon: <FileCode />, onClick: () => newQueryTab(conn.id, db) },
      ...(isMy
        ? [
            { label: 'Diagramme ERD', icon: <Network />, onClick: () => openTab({ id: uid(), kind: 'erd', connectionId: conn.id, database: db, schema: db }) },
            { label: 'Comparer avec…', icon: <GitCompareArrows />, onClick: () => openCompare(conn.id, db, db) },
            { label: 'Transférer les données…', icon: <ArrowRightLeft />, onClick: () => openTransfer(conn.id, db, db) },
          ]
        : []),
      ...(isMy ? [{ label: 'Nouvelle table', icon: <FilePlus2 />, onClick: () => openTab({ id: uid(), kind: 'designer', connectionId: conn.id, database: db, schema: db, table: null }) }] : []),
      ...(!isMy
        ? [
            {
              label: 'Créer un schéma',
              icon: <FolderTree />,
              onClick: async () => {
                const name = await promptDialog('Nouveau schéma', { confirmLabel: 'Créer' });
                if (name) await runAdmin(conn.id, db, `CREATE SCHEMA ${quoteIdent('postgres', name)}`, { success: `Schéma ${name} créé`, refresh: [key] });
              },
            } as MenuItem,
          ]
        : []),
      { separator: true },
      { label: 'Sauvegarder (dump)…', icon: <FileDown />, onClick: () => openTab({ id: uid(), kind: 'backup', connectionId: conn.id, database: db, mode: 'dump' }) },
      { label: 'Restaurer dans cette base…', icon: <Upload />, onClick: () => openTab({ id: uid(), kind: 'backup', connectionId: conn.id, database: db, mode: 'restore' }) },
      { label: 'Actualiser', icon: <RefreshCw />, onClick: () => bumpTree(key) },
      { label: 'Copier le nom', icon: <Copy />, onClick: () => copyText(db) },
      { separator: true },
      {
        label: 'Supprimer la base…',
        icon: <Trash2 />,
        danger: true,
        onClick: async () => {
          const typed = await promptDialog(`Supprimer définitivement la base « ${db} » ?`, {
            message: `Toutes les données seront perdues. Tape le nom de la base pour confirmer.`,
            confirmLabel: 'Supprimer',
          });
          if (typed !== db) {
            if (typed !== null) toast('Le nom saisi ne correspond pas : rien n’a été supprimé.');
            return;
          }
          await runAdmin(conn.id, '', `DROP DATABASE ${quoteIdent(conn.kind, db)}`, { success: `Base ${db} supprimée`, refresh: [conn.id] });
        },
      },
    ]);

  return (
    <>
      <Row
        depth={1}
        expandable
        open={open}
        onToggle={() => setOpen(!open)}
        onMenu={menu}
        icon={<Database className="ico ico-db" />}
        label={db}
        className={conn.database === db ? '' : ''}
      />
      {open && !schemas && !error && <Loading depth={2} />}
      {open && error && <ErrorRow depth={2} text={error} />}
      {open &&
        schemas &&
        (isMy ? (
          <ObjectsNode conn={conn} db={db} schema={db} depth={2} />
        ) : (
          schemas.map((s) => <SchemaNode key={s} conn={conn} db={db} schema={s} />)
        ))}
    </>
  );
}

// ---------- Schéma (PG) ----------
function SchemaNode({ conn, db, schema }: { conn: ListedConnection; db: string; schema: string }) {
  const key = `${conn.id}|${db}|${schema}`;
  const [open, setOpen] = useExpanded(key, schema === 'public');
  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      { label: 'Nouvelle requête', icon: <FileCode />, onClick: () => newQueryTab(conn.id, db, `SET search_path TO ${quoteIdent('postgres', schema)};\n\n`) },
      { label: 'Diagramme ERD', icon: <Network />, onClick: () => openTab({ id: uid(), kind: 'erd', connectionId: conn.id, database: db, schema }) },
      { label: 'Comparer avec…', icon: <GitCompareArrows />, onClick: () => openCompare(conn.id, db, schema) },
      { label: 'Transférer les données…', icon: <ArrowRightLeft />, onClick: () => openTransfer(conn.id, db, schema) },
      { label: 'Nouvelle table', icon: <FilePlus2 />, onClick: () => openTab({ id: uid(), kind: 'designer', connectionId: conn.id, database: db, schema, table: null }) },
      { label: 'Actualiser', icon: <RefreshCw />, onClick: () => bumpTree(key) },
      { label: 'Copier le nom', icon: <Copy />, onClick: () => copyText(schema) },
      { separator: true },
      {
        label: 'Supprimer le schéma…',
        icon: <Trash2 />,
        danger: true,
        onClick: () =>
          runAdmin(conn.id, db, `DROP SCHEMA ${quoteIdent('postgres', schema)} CASCADE`, {
            confirm: `Supprimer le schéma ${schema} et tout son contenu ?`,
            success: `Schéma ${schema} supprimé`,
            refresh: [`${conn.id}|${db}`],
          }),
      },
    ]);
  return (
    <>
      <Row depth={2} expandable open={open} onToggle={() => setOpen(!open)} onMenu={menu} icon={<Folder className="ico ico-db" />} label={schema} />
      {open && <ObjectsNode conn={conn} db={db} schema={schema} depth={3} />}
    </>
  );
}

// ---------- Catégories d'objets ----------
function ObjectsNode({ conn, db, schema, depth }: { conn: ListedConnection; db: string; schema: string; depth: number }) {
  const key = `${conn.id}|${db}|${schema}`;
  const version = useApp((s) => s.treeVersion[key] ?? 0);
  const { data, error } = useLoader(true, version, () => api.objects(conn.id, db, schema));
  if (error) return <ErrorRow depth={depth} text={error} />;
  if (!data) return <Loading depth={depth} />;
  return (
    <>
      {CATEGORIES.map((cat) => {
        const items = data.filter((o) => o.type === cat.type);
        if (!items.length && cat.type !== 'table') return null;
        return <CategoryNode key={cat.type} conn={conn} db={db} schema={schema} depth={depth} cat={cat} items={items} />;
      })}
    </>
  );
}

function CategoryNode(props: {
  conn: ListedConnection;
  db: string;
  schema: string;
  depth: number;
  cat: (typeof CATEGORIES)[number];
  items: DbObject[];
}) {
  const { conn, db, schema, depth, cat, items } = props;
  const key = `${conn.id}|${db}|${schema}|${cat.type}`;
  const [open, setOpen] = useExpanded(key, cat.type === 'table');
  const visible = filterText ? items.filter((i) => i.name.toLowerCase().includes(filterText)) : items;
  if (filterText && !visible.length) return null;
  const isOpen = open || (!!filterText && visible.length > 0);
  const menu = (e: React.MouseEvent) =>
    openMenu(e, [
      ...(cat.type === 'table'
        ? [{ label: 'Nouvelle table', icon: <FilePlus2 />, onClick: () => openTab({ id: uid(), kind: 'designer', connectionId: conn.id, database: db, schema, table: null }) }]
        : []),
      { label: 'Actualiser', icon: <RefreshCw />, onClick: () => bumpTree(`${conn.id}|${db}|${schema}`) },
    ]);
  return (
    <>
      <Row depth={depth} expandable open={isOpen} onToggle={() => setOpen(!open)} onMenu={menu} icon={cat.icon} label={cat.label} meta={visible.length} />
      {isOpen && visible.map((o) => <ObjectNode key={`${o.type}:${o.name}:${o.extra ?? ''}`} {...props} depth={depth + 1} obj={o} />)}
    </>
  );
}

function ObjectNode(props: { conn: ListedConnection; db: string; schema: string; depth: number; cat: (typeof CATEGORIES)[number]; obj: DbObject }) {
  const { conn, db, schema, depth, cat, obj } = props;
  const kind = conn.kind;
  const q = qualified(kind, db, schema, obj.name);
  const parentKey = `${conn.id}|${db}|${schema}`;
  const isRel = obj.type === 'table' || obj.type === 'view' || obj.type === 'matview';

  const openData = () => openTab({ id: uid(), kind: 'table', connectionId: conn.id, database: db, schema, table: obj.name, objType: obj.type, view: 'data' });
  const openDdl = async () => {
    try {
      const ddl = await api.ddl(conn.id, db, schema, obj.name, obj.type, obj.extra);
      newQueryTab(conn.id, db, ddl, obj.name);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const dropSql = () => {
    switch (obj.type) {
      case 'table':
        return `DROP TABLE ${q}`;
      case 'view':
        return `DROP VIEW ${q}`;
      case 'matview':
        return `DROP MATERIALIZED VIEW ${q}`;
      case 'sequence':
        return `DROP SEQUENCE ${q}`;
      case 'function':
        return kind === 'postgres' ? `DROP FUNCTION ${q}(${obj.extra ?? ''})` : `DROP FUNCTION ${q}`;
      case 'procedure':
        return kind === 'postgres' ? `DROP PROCEDURE ${q}(${obj.extra ?? ''})` : `DROP PROCEDURE ${q}`;
      case 'trigger':
        return kind === 'postgres' ? `DROP TRIGGER ${quoteIdent(kind, obj.name)} ON ${qualified(kind, db, schema, obj.extra ?? '')}` : `DROP TRIGGER ${q}`;
    }
  };

  const menu = (e: React.MouseEvent) => {
    const items: MenuItem[] = [];
    if (isRel) {
      items.push(
        { label: 'Ouvrir les données', icon: <Table2 />, onClick: openData },
        { label: 'Structure', icon: <Layers />, onClick: () => openTab({ id: uid(), kind: 'table', connectionId: conn.id, database: db, schema, table: obj.name, objType: obj.type, view: 'structure' }) },
      );
      if (obj.type === 'table') items.push({ label: 'Modifier la structure', icon: <Pencil />, onClick: () => openTab({ id: uid(), kind: 'designer', connectionId: conn.id, database: db, schema, table: obj.name }) });
      items.push(
        { label: 'Requête SELECT', icon: <FileCode />, onClick: () => newQueryTab(conn.id, db, `SELECT *\nFROM ${q}\nLIMIT 100;`) },
        { separator: true },
      );
      if (obj.type === 'table') items.push({ label: 'Importer un CSV…', icon: <FileInput />, onClick: () => openTab({ id: uid(), kind: 'import', connectionId: conn.id, database: db, schema, table: obj.name }) });
      items.push({ label: 'Exporter…', icon: <FileDown />, onClick: () => openExport({ connectionId: conn.id, database: db, schema, table: obj.name }) });
      if (obj.type === 'table') items.push({ label: 'Transférer vers…', icon: <ArrowRightLeft />, onClick: () => openTransfer(conn.id, db, schema, [obj.name]) });
      if (obj.type === 'table')
        items.push({
          label: 'Sauvegarder cette table…',
          icon: <FileDown />,
          onClick: () =>
            openTab({ id: uid(), kind: 'backup', connectionId: conn.id, database: db, mode: 'dump', tables: [kind === 'postgres' ? `${schema}.${obj.name}` : obj.name] }),
        });
      if (obj.type === 'matview')
        items.push({ label: 'Rafraîchir la vue matérialisée', icon: <RefreshCw />, onClick: () => runAdmin(conn.id, db, `REFRESH MATERIALIZED VIEW ${q}`, { success: 'Vue rafraîchie' }) });
    }
    items.push({ label: 'Voir le code (DDL)', icon: <Code2 />, onClick: openDdl });
    items.push({ label: 'Copier le nom', icon: <Copy />, onClick: () => copyText(obj.name) });
    items.push({ separator: true });
    if (obj.type === 'table') {
      items.push({
        label: 'Renommer…',
        icon: <Pencil />,
        onClick: async () => {
          const name = await promptDialog('Renommer la table', { defaultValue: obj.name, confirmLabel: 'Renommer' });
          if (!name || name === obj.name) return;
          const sql = kind === 'postgres' ? `ALTER TABLE ${q} RENAME TO ${quoteIdent(kind, name)}` : `RENAME TABLE ${q} TO ${qualified(kind, db, schema, name)}`;
          await runAdmin(conn.id, db, sql, { success: 'Table renommée', refresh: [parentKey] });
        },
      });
      items.push({
        label: 'Vider (TRUNCATE)…',
        icon: <Trash2 />,
        danger: true,
        onClick: () => runAdmin(conn.id, db, `TRUNCATE TABLE ${q}`, { confirm: `Vider toutes les lignes de ${obj.name} ?`, success: `${obj.name} vidée` }),
      });
    }
    items.push({
      label: 'Supprimer…',
      icon: <Trash2 />,
      danger: true,
      onClick: () => runAdmin(conn.id, db, dropSql(), { confirm: `Supprimer ${obj.name} ?`, success: `${obj.name} supprimé`, refresh: [parentKey] }),
    });
    openMenu(e, items);
  };

  return (
    <Row
      depth={depth}
      icon={cat.icon}
      label={obj.name}
      meta={obj.type === 'trigger' ? obj.extra : obj.type === 'function' || obj.type === 'procedure' ? (obj.extra ? `(${obj.extra.length > 24 ? '…' : obj.extra})` : '()') : undefined}
      onDouble={isRel ? openData : openDdl}
      onMenu={menu}
      title={obj.extra ? `${obj.name} — ${obj.extra}` : obj.name}
    />
  );
}

