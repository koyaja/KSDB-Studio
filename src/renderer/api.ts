// Accès typé au process principal.
import type {
  ApiResult,
  CellValue,
  ColumnInfo,
  ConnectionConfig,
  CsvPreview,
  DbObject,
  DumpOptions,
  ExportFormat,
  ExportTableOptions,
  HistoryEntry,
  ImportCsvOptions,
  JobEvent,
  ObjectType,
  ProcessInfo,
  PublicConnection,
  QueryResult,
  RestoreOptions,
  ResultField,
  RowChange,
  ServerInfo,
  Settings,
  TablePage,
  TableStructure,
  ToolStatus,
  GroupSettings,
  ErdModel,
  AppInfo,
  UpdateInfo,
  VpnBackendInfo,
  VpnProfile,
  VpnStatus,
} from '../shared/types';

declare global {
  interface Window {
    ksdb: {
      invoke: (channel: string, ...args: unknown[]) => Promise<ApiResult<unknown>>;
      onJob: (cb: (ev: JobEvent) => void) => () => void;
      onVpn: (cb: (ev: VpnEvent) => void) => () => void;
      onUpdate: (cb: (ev: UpdateEvent) => void) => () => void;
      platform: string;
    };
  }
}

export class ApiError extends Error {}

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = await window.ksdb.invoke(channel, ...args);
  if (!r.ok) throw new ApiError(r.error);
  return r.data as T;
}

export type ListedConnection = PublicConnection & { connected: boolean; effectiveVpnId: string | null };

export interface VpnEvent {
  id: string;
  state: 'up' | 'down' | 'unknown' | 'starting' | 'stopping';
  ownedBySession?: boolean;
  detail?: string;
}

export type UpdateEvent = (UpdateInfo & { open?: boolean }) | { progress: { done: number; total: number } };

export interface VpnEntry {
  profile: VpnProfile;
  status: VpnStatus;
}

export interface PageOptions {
  limit: number;
  offset: number;
  where?: string;
  orderBy?: { column: string; dir: 'asc' | 'desc' }[];
}

export interface Completion {
  schemas: Record<string, Record<string, string[]>>;
  defaultSchema: string;
}

export const api = {
  settings: () => call<Settings>('app:settings'),
  saveSettings: (s: Settings) => call<void>('app:saveSettings', s),
  tools: () => call<ToolStatus[]>('app:tools'),
  workspace: () => call<unknown>('app:workspace'),
  saveWorkspace: (w: unknown) => call<void>('app:saveWorkspace', w),
  openDialog: (opts: { title?: string; filters?: { name: string; extensions: string[] }[]; properties?: string[] }) =>
    call<string[] | null>('app:openDialog', opts),
  saveDialog: (opts: { title?: string; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }) =>
    call<string | null>('app:saveDialog', opts),
  readText: (p: string) => call<string>('app:readText', p),
  writeText: (p: string, c: string) => call<void>('app:writeText', p, c),
  showItem: (p: string) => call<void>('app:showItem', p),
  openExternal: (url: string) => call<void>('app:openExternal', url),
  appInfo: () => call<AppInfo>('app:info'),
  checkUpdate: () => call<UpdateInfo | null>('app:checkUpdate'),
  lastUpdate: () => call<UpdateInfo | null>('app:lastUpdate'),
  downloadUpdate: () => call<string>('app:downloadUpdate'),
  cancelDownload: () => call<void>('app:cancelDownload'),
  installUpdate: (file: string) => call<'started' | 'relaunch' | 'manual'>('app:installUpdate', file),

  listConnections: () => call<ListedConnection[]>('conn:list'),
  saveConnection: (c: ConnectionConfig) => call<string>('conn:save', c),
  deleteConnection: (id: string) => call<void>('conn:delete', id),
  reorderConnections: (ids: string[]) => call<void>('conn:reorder', ids),
  testConnection: (c: ConnectionConfig) => call<ServerInfo>('conn:test', c),
  connect: (id: string, password?: string) => call<ServerInfo>('conn:connect', id, password),
  disconnect: (id: string) => call<void>('conn:disconnect', id),
  importNavicat: (file: string) => call<{ imported: number; skipped: { name: string; type: string }[] }>('conn:importNavicat', file),
  exportConnections: (file: string, ids: string[], withPasswords: boolean) => call<number>('conn:exportFile', file, ids, withPasswords),
  importConnections: (file: string) => call<number>('conn:importFile', file),

  groups: () => call<Record<string, GroupSettings>>('group:list'),
  setGroup: (name: string, g: GroupSettings) => call<void>('group:set', name, g),
  renameGroup: (from: string, to: string) => call<void>('group:rename', from, to),

  vpnBackend: () => call<VpnBackendInfo>('vpn:backend'),
  vpnList: () => call<VpnEntry[]>('vpn:list'),
  vpnInspect: (configPath: string) => call<{ endpoint: string | null; suggestedName: string }>('vpn:inspect', configPath),
  vpnSuggestName: (label: string) => call<string>('vpn:suggestName', label),
  vpnSave: (p: VpnProfile, source?: { configPath?: string; configText?: string }) => call<string>('vpn:save', p, source),
  vpnDelete: (id: string) => call<void>('vpn:delete', id),
  vpnStart: (id: string) => call<VpnStatus>('vpn:start', id),
  vpnStop: (id: string) => call<VpnStatus>('vpn:stop', id),

  serverInfo: (id: string) => call<ServerInfo>('db:serverInfo', id),
  databases: (id: string) => call<string[]>('db:databases', id),
  schemas: (id: string, db: string) => call<string[]>('db:schemas', id, db),
  objects: (id: string, db: string, schema: string) => call<DbObject[]>('db:objects', id, db, schema),
  structure: (id: string, db: string, schema: string, table: string) => call<TableStructure>('db:structure', id, db, schema, table),
  ddl: (id: string, db: string, schema: string, name: string, type: ObjectType, extra?: string) =>
    call<string>('db:ddl', id, db, schema, name, type, extra),
  erd: (id: string, db: string, schema: string) => call<ErdModel>('db:erd', id, db, schema),
  erdLayout: (key: string) => call<unknown>('app:erdLayout', key),
  saveErdLayout: (key: string, layout: unknown) => call<void>('app:saveErdLayout', key, layout),
  writeBase64: (p: string, b64: string) => call<void>('app:writeBase64', p, b64),
  completion: (id: string, db: string) => call<Completion>('db:completion', id, db),

  execute: (id: string, sessionId: string, db: string, sql: string) => call<QueryResult[]>('db:execute', id, sessionId, db, sql),
  cancel: (id: string, sessionId: string) => call<boolean>('db:cancel', id, sessionId),
  closeSession: (id: string, sessionId: string) => call<void>('db:closeSession', id, sessionId),
  history: () => call<HistoryEntry[]>('history:list'),
  clearHistory: () => call<void>('history:clear'),

  page: (id: string, db: string, schema: string, table: string, o: PageOptions) => call<TablePage>('db:page', id, db, schema, table, o),
  count: (id: string, db: string, schema: string, table: string, where?: string) => call<number>('db:count', id, db, schema, table, where),
  apply: (id: string, db: string, schema: string, table: string, changes: RowChange[], hiddenKey?: string) =>
    call<number>('db:apply', id, db, schema, table, changes, hiddenKey),
  preview: (id: string, db: string, schema: string, table: string, changes: RowChange[], hiddenKey?: string) =>
    call<string[]>('db:preview', id, db, schema, table, changes, hiddenKey),
  processes: (id: string) => call<ProcessInfo[]>('db:processes', id),
  kill: (id: string, pid: string, mode: 'cancel' | 'terminate') => call<void>('db:kill', id, pid, mode),

  exportRows: (file: string, format: ExportFormat, fields: ResultField[], rows: CellValue[][], table?: string, bom?: boolean, kind?: string) =>
    call<number>('db:exportRows', file, format, fields, rows, table, bom, kind),
  exportTable: (o: ExportTableOptions) => call<string>('job:exportTable', o),
  csvPreview: (file: string, delimiter: string | undefined, encoding: 'utf8' | 'latin1') =>
    call<CsvPreview>('csv:preview', file, delimiter, encoding),
  importCsv: (o: ImportCsvOptions) => call<string>('job:importCsv', o),
  dump: (o: DumpOptions) => call<string>('job:dump', o),
  restore: (o: RestoreOptions) => call<string>('job:restore', o),
  cancelJob: (jobId: string) => call<void>('job:cancel', jobId),
};

export type { ColumnInfo };
