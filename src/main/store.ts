// Persistance locale : connexions (secrets chiffrés), paramètres, historique, espace de travail.
import { app, safeStorage } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionConfig, GroupSettings, HistoryEntry, PublicConnection, Settings, VpnProfile } from '../shared/types';

export const dataDir = () => {
  const d = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path.join(dataDir(), file), 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown) {
  const p = path.join(dataDir(), file);
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function enc(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(s).toString('base64');
  return 'b64:' + Buffer.from(s, 'utf8').toString('base64');
}

function dec(s: string | undefined): string | undefined {
  if (!s) return undefined;
  try {
    if (s.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64'));
    if (s.startsWith('b64:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
  } catch {
    return undefined;
  }
  return undefined;
}

interface StoredConnection extends Omit<ConnectionConfig, 'password' | 'ssh'> {
  passwordEnc?: string;
  ssh: Omit<ConnectionConfig['ssh'], 'password' | 'passphrase'> & { passwordEnc?: string; passphraseEnc?: string };
}

export class Store {
  private conns: StoredConnection[] = readJson('connections.json', []);

  private persist() {
    writeJson('connections.json', this.conns);
  }

  list(): PublicConnection[] {
    return this.conns.map((c) => {
      const { passwordEnc, ssh, ...rest } = c;
      const { passwordEnc: sp, passphraseEnc: spp, ...sshRest } = ssh;
      return {
        ...rest,
        hasPassword: !!passwordEnc,
        hasSshPassword: !!sp,
        hasPassphrase: !!spp,
        ssh: { ...sshRest },
      };
    });
  }

  get(id: string): ConnectionConfig | undefined {
    const c = this.conns.find((x) => x.id === id);
    if (!c) return undefined;
    const { passwordEnc, ssh, ...rest } = c;
    const { passwordEnc: sp, passphraseEnc: spp, ...sshRest } = ssh;
    return { ...rest, password: dec(passwordEnc), ssh: { ...sshRest, password: dec(sp), passphrase: dec(spp) } };
  }

  /** password/ssh.password undefined = inchangé ; chaîne vide = effacé. */
  save(cfg: ConnectionConfig): ConnectionConfig {
    const id = cfg.id || crypto.randomUUID();
    const prev = this.conns.find((x) => x.id === id);
    const keep = (incoming: string | undefined, old: string | undefined) => (incoming === undefined ? old : enc(incoming));
    const { password, ssh, ...rest } = cfg;
    const { password: sp, passphrase: spp, ...sshRest } = ssh;
    const stored: StoredConnection = {
      ...rest,
      id,
      passwordEnc: cfg.savePassword ? keep(password, prev?.passwordEnc) : undefined,
      ssh: { ...sshRest, passwordEnc: keep(sp, prev?.ssh.passwordEnc), passphraseEnc: keep(spp, prev?.ssh.passphraseEnc) },
    };
    if (prev) this.conns = this.conns.map((x) => (x.id === id ? stored : x));
    else this.conns.push(stored);
    this.persist();
    return this.get(id)!;
  }

  remove(id: string) {
    this.conns = this.conns.filter((x) => x.id !== id);
    this.persist();
  }

  reorder(ids: string[]) {
    const pos = new Map(ids.map((id, i) => [id, i]));
    this.conns.sort((a, b) => (pos.get(a.id) ?? 1e9) - (pos.get(b.id) ?? 1e9));
    this.persist();
  }

  // ---- Groupes ----
  groups(): Record<string, GroupSettings> {
    return readJson<Record<string, GroupSettings>>('groups.json', {});
  }

  setGroup(name: string, g: GroupSettings) {
    const all = this.groups();
    if (!g.vpnId) delete all[name];
    else all[name] = g;
    writeJson('groups.json', all);
  }

  renameGroup(from: string, to: string) {
    const all = this.groups();
    if (all[from]) {
      all[to] = all[from];
      delete all[from];
      writeJson('groups.json', all);
    }
    this.conns = this.conns.map((c) => (c.group === from ? { ...c, group: to } : c));
    this.persist();
  }

  // ---- Profils VPN (configuration WireGuard chiffrée) ----
  private vpnStore(): (VpnProfile & { configEnc?: string })[] {
    return readJson('vpn.json', []);
  }

  vpnProfiles(): VpnProfile[] {
    return this.vpnStore().map(({ configEnc, ...p }) => ({ ...p, hasConfig: !!configEnc }));
  }

  vpnProfile(id: string): VpnProfile | undefined {
    return this.vpnProfiles().find((p) => p.id === id);
  }

  vpnConfig(id: string): string | undefined {
    return dec(this.vpnStore().find((p) => p.id === id)?.configEnc);
  }

  /** config undefined = inchangée */
  saveVpn(p: VpnProfile, config?: string): VpnProfile {
    const all = this.vpnStore();
    const id = p.id || crypto.randomUUID();
    const prev = all.find((x) => x.id === id);
    const { hasConfig: _h, ...rest } = p;
    const stored = { ...rest, id, configEnc: config === undefined ? prev?.configEnc : enc(config) };
    writeJson('vpn.json', prev ? all.map((x) => (x.id === id ? stored : x)) : [...all, stored]);
    return this.vpnProfile(id)!;
  }

  removeVpn(id: string) {
    writeJson('vpn.json', this.vpnStore().filter((p) => p.id !== id));
    // retirer les associations
    this.conns = this.conns.map((c) => (c.vpnId === id ? { ...c, vpnId: undefined } : c));
    this.persist();
    const g = this.groups();
    for (const k of Object.keys(g)) if (g[k].vpnId === id) delete g[k];
    writeJson('groups.json', g);
  }

  /** VPN effectif d'une connexion : le sien, sinon celui de son groupe. */
  effectiveVpnId(conn: { vpnId?: string; group?: string }): string | undefined {
    if (conn.vpnId === 'none') return undefined;
    if (conn.vpnId) return conn.vpnId;
    const g = conn.group?.trim();
    return g ? this.groups()[g]?.vpnId : undefined;
  }

  // ---- Paramètres ----
  settings(): Settings {
    return {
      theme: 'dark',
      maxRows: 2000,
      pageSize: 200,
      editorFontSize: 13,
      uppercaseKeywords: true,
      binaries: {},
      ...readJson<Partial<Settings>>('settings.json', {}),
    };
  }

  saveSettings(s: Settings) {
    writeJson('settings.json', s);
  }

  // ---- Historique ----
  private historyCache: HistoryEntry[] | null = null;

  history(): HistoryEntry[] {
    this.historyCache ??= readJson<HistoryEntry[]>('history.json', []);
    return this.historyCache;
  }

  addHistory(e: HistoryEntry) {
    const h = this.history();
    h.unshift(e);
    if (h.length > 1000) h.length = 1000;
    writeJson('history.json', h);
  }

  clearHistory() {
    this.historyCache = [];
    writeJson('history.json', []);
  }

  // ---- Espace de travail (onglets de requêtes ouverts) ----
  workspace(): unknown {
    return readJson('workspace.json', null);
  }

  saveWorkspace(w: unknown) {
    writeJson('workspace.json', w);
  }
}
