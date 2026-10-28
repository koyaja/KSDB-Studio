// État global minimaliste (pas de dépendance externe).
import { useSyncExternalStore } from 'react';
import type { ObjectType, Settings } from '../shared/types';
import { api, ListedConnection, VpnEntry, VpnEvent } from './api';
import type { GroupSettings, ThemeId } from '../shared/types';

export type Tab =
  | { id: string; kind: 'query'; title: string; connectionId: string | null; database: string; sql: string; filePath?: string; dirty?: boolean }
  | { id: string; kind: 'table'; connectionId: string; database: string; schema: string; table: string; objType: ObjectType; view: 'data' | 'structure' | 'ddl'; where?: string }
  | { id: string; kind: 'designer'; connectionId: string; database: string; schema: string; table: string | null }
  | { id: string; kind: 'backup'; connectionId: string; database: string; mode: 'dump' | 'restore'; tables?: string[] }
  | { id: string; kind: 'import'; connectionId: string; database: string; schema: string; table: string }
  | { id: string; kind: 'processes'; connectionId: string }
  | { id: string; kind: 'erd'; connectionId: string; database: string; schema: string }
  | { id: string; kind: 'history' }
  | { id: string; kind: 'settings' };

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
}

export interface DialogRequest {
  id: number;
  kind: 'confirm' | 'prompt';
  title: string;
  message?: string;
  danger?: boolean;
  confirmLabel?: string;
  defaultValue?: string;
  password?: boolean;
  resolve: (v: string | boolean | null) => void;
}

export interface AppState {
  connections: ListedConnection[];
  settings: Settings;
  tabs: Tab[];
  activeTab: string | null;
  toasts: Toast[];
  dialog: DialogRequest | null;
  /** incrémenté pour forcer le rechargement d'un nœud de l'arbre : clé "connId|db|schema" */
  treeVersion: Record<string, number>;
  editingConnection: { id: string | null; group?: string } | null;
  /** thème appliqué */
  themeResolved: ThemeId;
  /** le thème appliqué est-il sombre (coloration de l'éditeur, icônes) */
  themeDark: boolean;
  vpns: VpnEntry[];
  /** état transitoire / dernière erreur par profil VPN */
  vpnTransient: Record<string, { state: 'starting' | 'stopping' | null; detail?: string }>;
  groups: Record<string, GroupSettings>;
  vpnManagerOpen: boolean;
}

const listeners = new Set<() => void>();
let state: AppState = {
  connections: [],
  settings: { theme: 'dark', maxRows: 2000, pageSize: 200, editorFontSize: 13, uppercaseKeywords: true, binaries: {} },
  tabs: [],
  activeTab: null,
  toasts: [],
  dialog: null,
  treeVersion: {},
  editingConnection: null,
  themeResolved: 'dark',
  themeDark: true,
  vpns: [],
  vpnTransient: {},
  groups: {},
  vpnManagerOpen: false,
};

export function getState() {
  return state;
}

export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  listeners.forEach((l) => l());
  if ('tabs' in p || 'activeTab' in p) scheduleWorkspaceSave();
}

export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => sel(state),
  );
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// ---------- Toasts et dialogues ----------
let toastSeq = 0;
export function toast(text: string, kind: Toast['kind'] = 'info') {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 9000 : 4000);
}

let dialogSeq = 0;
export function confirmDialog(title: string, message?: string, opts: { danger?: boolean; confirmLabel?: string } = {}) {
  return new Promise<boolean>((resolve) =>
    setState({
      dialog: { id: ++dialogSeq, kind: 'confirm', title, message, ...opts, resolve: (v) => resolve(!!v) },
    }),
  );
}

export function promptDialog(title: string, opts: { message?: string; defaultValue?: string; password?: boolean; confirmLabel?: string } = {}) {
  return new Promise<string | null>((resolve) =>
    setState({
      dialog: { id: ++dialogSeq, kind: 'prompt', title, ...opts, resolve: (v) => resolve(v === null ? null : String(v)) },
    }),
  );
}

// ---------- Connexions ----------
export async function refreshConnections() {
  const connections = await api.listConnections();
  setState({ connections });
}

export function connectionById(id: string | null | undefined) {
  return state.connections.find((c) => c.id === id);
}

/** Connecte en demandant le mot de passe si nécessaire. Renvoie false si annulé. */
export async function ensureConnected(id: string): Promise<boolean> {
  const c = connectionById(id);
  if (c?.connected) return true;
  let password: string | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await api.connect(id, password);
      await refreshConnections();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'PASSWORD_REQUIRED' || (password !== undefined && /password|mot de passe|authentication|Access denied/i.test(msg))) {
        if (password !== undefined) toast(msg, 'error');
        const pw = await promptDialog(`Mot de passe pour ${c?.name ?? 'la connexion'}`, {
          message: `${c?.user ?? ''}@${c?.host ?? ''}`,
          password: true,
          confirmLabel: 'Se connecter',
        });
        if (pw === null) return false;
        password = pw;
        continue;
      }
      toast(msg, 'error');
      return false;
    }
  }
  return false;
}

export function bumpTree(key: string) {
  setState((s) => ({ treeVersion: { ...s.treeVersion, [key]: (s.treeVersion[key] ?? 0) + 1 } }));
}

// ---------- Onglets ----------
export function openTab(tab: Tab) {
  const existing = state.tabs.find((t) => sameTarget(t, tab));
  if (existing) {
    if (existing.kind === 'table' && tab.kind === 'table' && existing.view !== tab.view)
      updateTab(existing.id, { view: tab.view } as Partial<Tab>);
    setState({ activeTab: existing.id });
    return existing.id;
  }
  setState((s) => ({ tabs: [...s.tabs, tab], activeTab: tab.id }));
  return tab.id;
}

function sameTarget(a: Tab, b: Tab): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'table':
    case 'import': {
      const bb = b as typeof a;
      return a.connectionId === bb.connectionId && a.database === bb.database && a.schema === bb.schema && a.table === bb.table;
    }
    case 'designer': {
      const bb = b as typeof a;
      return a.table !== null && a.connectionId === bb.connectionId && a.database === bb.database && a.schema === bb.schema && a.table === bb.table;
    }
    case 'processes':
      return a.connectionId === (b as typeof a).connectionId;
    case 'erd': {
      const bb = b as typeof a;
      return a.connectionId === bb.connectionId && a.database === bb.database && a.schema === bb.schema;
    }
    case 'history':
    case 'settings':
      return true;
    default:
      return false;
  }
}

export function updateTab(id: string, patch: Partial<Tab>) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t)) }));
}

export async function closeTab(id: string) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.kind === 'query') {
    if (tab.dirty && tab.filePath && !(await confirmDialog('Fermer sans enregistrer ?', `Les modifications de ${tab.title} seront perdues.`)))
      return;
    if (tab.connectionId) api.closeSession(tab.connectionId, tab.id).catch(() => {});
  }
  setState((s) => {
    const idx = s.tabs.findIndex((t) => t.id === id);
    const tabs = s.tabs.filter((t) => t.id !== id);
    const activeTab = s.activeTab === id ? (tabs[Math.min(idx, tabs.length - 1)]?.id ?? null) : s.activeTab;
    return { tabs, activeTab };
  });
}

let queryCounter = 0;
export function newQueryTab(connectionId: string | null, database = '', sql = '', title?: string) {
  const c = connectionById(connectionId);
  if (!title) queryCounter++;
  return openTab({
    id: uid(),
    kind: 'query',
    title: title ?? `Requête ${queryCounter}`,
    connectionId,
    database: database || c?.database || '',
    sql,
  });
}

// ---------- Persistance de l'espace de travail ----------
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleWorkspaceSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const queries = state.tabs.filter((t): t is Extract<Tab, { kind: 'query' }> => t.kind === 'query');
    api.saveWorkspace({ queries, activeTab: state.activeTab, counter: queryCounter }).catch(() => {});
  }, 800);
}

export async function restoreWorkspace() {
  const w = (await api.workspace().catch(() => null)) as { queries?: Tab[]; activeTab?: string; counter?: number } | null;
  if (!w?.queries?.length) return;
  queryCounter = w.counter ?? w.queries.length;
  setState({ tabs: w.queries, activeTab: w.queries.some((q) => q.id === w.activeTab) ? w.activeTab! : w.queries[0].id });
}

export async function saveSettings(s: Settings) {
  setState({ settings: s });
  await api.saveSettings(s);
}

// ---------- VPN ----------
export async function refreshVpns() {
  const [vpns, groups] = await Promise.all([api.vpnList(), api.groups()]);
  setState({ vpns, groups });
}

export function onVpnEvent(ev: VpnEvent) {
  setState((s) => {
    const transient = { ...s.vpnTransient };
    if (ev.state === 'starting' || ev.state === 'stopping') transient[ev.id] = { state: ev.state };
    else transient[ev.id] = { state: null, detail: ev.detail };
    const vpns = s.vpns.map((v) =>
      v.profile.id === ev.id && (ev.state === 'up' || ev.state === 'down' || ev.state === 'unknown')
        ? { ...v, status: { ...v.status, state: ev.state, ownedBySession: ev.ownedBySession ?? v.status.ownedBySession } }
        : v,
    );
    return { vpnTransient: transient, vpns };
  });
  if (ev.state === 'down' || ev.state === 'up') refreshConnections().catch(() => {});
}

export function vpnById(id: string | null | undefined) {
  return state.vpns.find((v) => v.profile.id === id);
}

export async function startVpn(id: string) {
  const v = vpnById(id);
  try {
    await api.vpnStart(id);
    toast(`VPN « ${v?.profile.name ?? ''} » actif`, 'success');
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    refreshVpns().catch(() => {});
  }
}

export async function stopVpn(id: string) {
  const v = vpnById(id);
  const users = state.connections.filter((c) => c.connected && c.effectiveVpnId === id);
  if (users.length && !(await confirmDialog(`Arrêter le VPN « ${v?.profile.name} » ?`, `Les connexions ouvertes seront fermées : ${users.map((u) => u.name).join(', ')}`, { confirmLabel: 'Arrêter' })))
    return;
  try {
    await api.vpnStop(id);
    toast(`VPN « ${v?.profile.name ?? ''} » arrêté`);
  } catch (e) {
    toast((e as Error).message, 'error');
  } finally {
    refreshVpns().catch(() => {});
    refreshConnections().catch(() => {});
  }
}
