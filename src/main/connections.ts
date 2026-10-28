// Gestion des connexions actives : tunnel SSH + driver par connexion.
import type { ConnectionConfig } from '../shared/types';
import type { Driver, Endpoint } from './drivers/base';
import { MysqlDriver } from './drivers/mysql';
import { PostgresDriver } from './drivers/postgres';
import { openTunnel, Tunnel } from './tunnel';

export const PASSWORD_REQUIRED = 'PASSWORD_REQUIRED';

interface Live {
  cfg: ConnectionConfig;
  driver: Driver;
  tunnel: Tunnel | null;
  endpoint: () => Promise<Endpoint>;
}

export function createDriver(cfg: ConnectionConfig): { driver: Driver; endpoint: () => Promise<Endpoint>; dispose: () => void } {
  let tunnel: Tunnel | null = null;
  let pending: Promise<Tunnel> | null = null;
  const endpoint = async (): Promise<Endpoint> => {
    if (!cfg.ssh?.enabled) return { host: cfg.host, port: cfg.port };
    if (tunnel && tunnel.alive()) return { host: '127.0.0.1', port: tunnel.port };
    pending ??= openTunnel(cfg.ssh, cfg.host || '127.0.0.1', cfg.port).finally(() => (pending = null));
    tunnel = await pending;
    return { host: '127.0.0.1', port: tunnel.port };
  };
  const driver = cfg.kind === 'postgres' ? new PostgresDriver(cfg, endpoint) : new MysqlDriver(cfg, endpoint);
  return { driver, endpoint, dispose: () => tunnel?.close() };
}

export class ConnectionManager {
  private live = new Map<string, Live & { dispose: () => void }>();
  private runtimePasswords = new Map<string, string>();

  constructor(
    private resolve: (id: string) => ConnectionConfig | undefined,
    /** Préparation avant connexion (démarrage du VPN associé) */
    private prepare: (cfg: ConnectionConfig) => Promise<void> = async () => {},
  ) {}

  setRuntimePassword(id: string, password: string) {
    this.runtimePasswords.set(id, password);
  }

  isConnected(id: string) {
    return this.live.has(id);
  }

  connectedIds() {
    return [...this.live.keys()];
  }

  async get(id: string): Promise<Driver> {
    return (await this.entry(id)).driver;
  }

  async entry(id: string): Promise<Live> {
    const existing = this.live.get(id);
    if (existing) return existing;
    const stored = this.resolve(id);
    if (!stored) throw new Error('Connexion introuvable');
    const cfg = { ...stored };
    if (!cfg.savePassword) {
      const pw = this.runtimePasswords.get(id);
      if (pw === undefined) throw new Error(PASSWORD_REQUIRED);
      cfg.password = pw;
    }
    await this.prepare(cfg);
    const { driver, endpoint, dispose } = createDriver(cfg);
    try {
      await driver.serverInfo();
    } catch (e) {
      await driver.close().catch(() => {});
      dispose();
      if (!cfg.savePassword) this.runtimePasswords.delete(id);
      throw e;
    }
    const entry = { cfg, driver, tunnel: null, endpoint, dispose };
    this.live.set(id, entry);
    return entry;
  }

  async disconnect(id: string) {
    const e = this.live.get(id);
    if (!e) return;
    this.live.delete(id);
    await e.driver.close().catch(() => {});
    e.dispose();
  }

  async disconnectAll() {
    await Promise.all([...this.live.keys()].map((id) => this.disconnect(id)));
  }

  /** Teste une configuration sans l'enregistrer. */
  static async test(cfg: ConnectionConfig) {
    const { driver, dispose } = createDriver(cfg);
    try {
      return await driver.serverInfo();
    } finally {
      await driver.close().catch(() => {});
      dispose();
    }
  }
}
