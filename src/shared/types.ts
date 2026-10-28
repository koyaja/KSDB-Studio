// Types partagés entre le process principal et l'interface.

export type DbKind = 'postgres' | 'mysql';

export interface SshConfig {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: 'password' | 'key';
  password?: string;
  keyPath?: string;
  passphrase?: string;
}

export interface SslConfig {
  mode: 'disable' | 'require' | 'verify';
  caPath?: string;
}

export interface ConnectionConfig {
  id: string;
  name: string;
  kind: DbKind;
  /** 'mariadb' est traité comme 'mysql', on garde l'étiquette pour l'affichage */
  flavor?: 'postgres' | 'mysql' | 'mariadb';
  host: string;
  port: number;
  user: string;
  password?: string;
  savePassword: boolean;
  database?: string;
  group?: string;
  color?: string;
  readOnly?: boolean;
  /** Demande une confirmation avant DROP/TRUNCATE/DELETE ou UPDATE sans WHERE */
  production?: boolean;
  ssl: SslConfig;
  ssh: SshConfig;
  /** Profil VPN propre à la connexion. undefined = hérite du groupe ; 'none' = aucun VPN même si le groupe en a un. */
  vpnId?: string;
}

// ---------- VPN WireGuard ----------

export interface VpnProfile {
  id: string;
  name: string;
  /**
   * file     : configuration .conf stockée (chiffrée) dans KSDB Studio
   * existing : tunnel déjà configuré sur la machine (application WireGuard sous Windows,
   *            NetworkManager ou /etc/wireguard sous Linux) ; on le démarre par son nom
   */
  mode: 'file' | 'existing';
  /** Nom du tunnel / de l'interface (≤ 15 caractères, lettres, chiffres, _ = + . -) */
  tunnelName: string;
  /** Arrêter le tunnel en quittant KSDB Studio s'il a été démarré par KSDB Studio */
  stopOnQuit: boolean;
  /** Démarrage automatique à l'ouverture d'une connexion associée */
  autoStart: boolean;
  /** mode file : présence d'une configuration enregistrée (jamais envoyée en clair à l'interface) */
  hasConfig?: boolean;
  /** Endpoint lu dans la configuration (affichage) */
  endpoint?: string;
}

export interface VpnStatus {
  id: string;
  state: 'up' | 'down' | 'unknown';
  /** Démarré par KSDB Studio pendant cette session */
  ownedBySession: boolean;
  detail?: string;
}

export interface VpnBackendInfo {
  platform: string;
  available: boolean;
  backend: 'wireguard-windows' | 'networkmanager' | 'wg-quick' | 'none';
  detail: string;
}

/** Version envoyée à l'interface : jamais de secret en clair. */
export interface GroupSettings {
  vpnId?: string;
}

export interface PublicConnection extends Omit<ConnectionConfig, 'password'> {
  hasPassword: boolean;
  hasSshPassword: boolean;
  hasPassphrase: boolean;
}

export type ObjectType =
  | 'table'
  | 'view'
  | 'matview'
  | 'function'
  | 'procedure'
  | 'sequence'
  | 'trigger';

export interface DbObject {
  name: string;
  type: ObjectType;
  /** table parente (triggers) ou signature (fonctions) */
  extra?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  comment: string | null;
  isPrimaryKey: boolean;
  autoIncrement: boolean;
  position: number;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition?: string;
}

export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  refSchema: string;
  refTable: string;
  refColumns: string[];
  onUpdate: string;
  onDelete: string;
}

export interface TableStructure {
  columns: ColumnInfo[];
  indexes: IndexInfo[];
  foreignKeys: ForeignKeyInfo[];
  primaryKey: string[];
  primaryKeyName?: string;
  comment?: string | null;
}

export type CellValue = string | number | boolean | null;

export interface ResultField {
  name: string;
  type?: string;
}

export interface QueryResult {
  statement: string;
  fields: ResultField[];
  rows: CellValue[][];
  rowCount: number;
  affectedRows?: number;
  truncated?: boolean;
  durationMs: number;
  command?: string;
  error?: string;
  /** Position (ligne) de l'erreur si connue */
  errorPosition?: number;
}

export interface TablePage {
  fields: ResultField[];
  rows: CellValue[][];
  /** clé utilisée pour identifier une ligne lors de l'édition */
  keyColumns: string[];
  /** nom de pseudo-colonne de clé quand il n'y a pas de PK (ctid PG) */
  hiddenKey?: string;
  editable: boolean;
  readOnlyReason?: string;
  sql: string;
  durationMs: number;
}

export type RowChange =
  | { type: 'update'; key: Record<string, CellValue>; set: Record<string, CellValue> }
  | { type: 'insert'; values: Record<string, CellValue> }
  | { type: 'delete'; key: Record<string, CellValue> };

export interface ProcessInfo {
  id: string;
  user: string;
  database: string;
  client: string;
  state: string;
  durationSec: number | null;
  query: string;
}

export interface ServerInfo {
  version: string;
  currentUser: string;
}

export interface HistoryEntry {
  id: string;
  connectionId: string;
  connectionName: string;
  database: string;
  sql: string;
  at: number;
  durationMs: number;
  ok: boolean;
}

export type ThemeId = 'dark' | 'light' | 'night' | 'paper';

export interface Settings {
  /** Thème fixe, ou « system » (suit le système) / « schedule » (selon l'heure) */
  theme: ThemeId | 'system' | 'schedule';
  /** Thèmes jour/nuit utilisés par « system » et « schedule » ; plage horaire de nuit */
  themeSchedule?: { day: ThemeId; night: ThemeId; from: string; to: string };
  maxRows: number;
  pageSize: number;
  editorFontSize: number;
  uppercaseKeywords: boolean;
  /** Vérifier les nouvelles versions au démarrage puis toutes les 6 h */
  checkUpdates?: boolean;
  /** Version dont l'utilisateur ne veut plus être averti */
  skippedVersion?: string;
  binaries: {
    pg_dump?: string;
    pg_restore?: string;
    psql?: string;
    mysqldump?: string;
    mysql?: string;
  };
}

export interface DumpOptions {
  connectionId: string;
  database: string;
  filePath: string;
  /** PG : plain = .sql, custom = .dump (pg_restore) */
  format: 'plain' | 'custom';
  content: 'all' | 'schema' | 'data';
  tables?: string[];
  schemas?: string[];
  createDatabase?: boolean;
  dropObjects?: boolean;
  noOwner?: boolean;
}

export interface RestoreOptions {
  connectionId: string;
  database: string;
  filePath: string;
  createDatabase?: boolean;
  clean?: boolean;
  noOwner?: boolean;
  jobs?: number;
}

export interface ImportCsvOptions {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  filePath: string;
  delimiter: string;
  header: boolean;
  emptyAsNull: boolean;
  truncate: boolean;
  encoding: 'utf8' | 'latin1';
  /** colonne CSV (index) -> colonne de table */
  mapping: { csvIndex: number; column: string }[];
}

export interface CsvPreview {
  headers: string[];
  rows: string[][];
  delimiter: string;
}

export type ExportFormat = 'csv' | 'json' | 'sql' | 'tsv';

export interface ExportTableOptions {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  where?: string;
  format: ExportFormat;
  filePath: string;
  csvBom?: boolean;
}

export interface JobEvent {
  jobId: string;
  kind: 'log' | 'progress' | 'done' | 'error' | 'data';
  message?: string;
  progress?: number;
  /** charge utile structurée (transfert de données) */
  data?: unknown;
}

export interface ToolStatus {
  name: keyof Settings['binaries'];
  path: string | null;
  version: string | null;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ---------- Diagramme ERD ----------

export interface ErdColumn {
  name: string;
  type: string;
  nullable: boolean;
  pk: boolean;
  fk: boolean;
}

export interface ErdTable {
  name: string;
  kind: 'table' | 'view';
  /** estimation du nombre de lignes */
  rows: number | null;
  comment: string | null;
  columns: ErdColumn[];
}

export interface ErdRelation {
  name: string;
  from: string;
  fromColumns: string[];
  toSchema: string;
  to: string;
  toColumns: string[];
  onDelete: string;
}

export interface ErdModel {
  schema: string;
  tables: ErdTable[];
  relations: ErdRelation[];
}

// ---------- Mises à jour ----------

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes: string;
  url: string;
  publishedAt: string;
  asset: { name: string; url: string; size: number } | null;
  installKind: 'windows' | 'appimage' | 'deb' | 'mac' | 'other';
}

export interface AppInfo {
  version: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
  node: string;
  installKind: 'windows' | 'appimage' | 'deb' | 'mac' | 'other';
  dataDir: string;
  releasesUrl: string;
}

// ---------- Transfert de données ----------

export interface TransferEndpoint {
  connectionId: string;
  database: string;
  /** schéma PG ; pour MySQL, identique à la base */
  schema: string;
}

export interface TransferOptions {
  source: TransferEndpoint;
  target: TransferEndpoint;
  tables: { name: string; where?: string }[];
  /** existing : tables déjà présentes ; create : créer les manquantes ; recreate : supprimer puis recréer */
  structure: 'existing' | 'create' | 'recreate';
  data: boolean;
  before: 'append' | 'truncate';
  onConflict: 'error' | 'ignore';
  resetSequences: boolean;
  disableChecks: boolean;
  continueOnError: boolean;
  batchSize: number;
}

export type TransferEvent =
  | { type: 'table'; table: string; state: 'pending' | 'running' | 'done' | 'error' | 'skipped'; rows?: number; error?: string; note?: string }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'summary'; tables: number; rows: number; errors: number; seconds: number };
