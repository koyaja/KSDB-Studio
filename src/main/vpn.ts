// Pilotage des tunnels WireGuard du système.
//  Windows : wireguard.exe /installtunnelservice | /uninstalltunnelservice (élévation UAC), statut via `sc query`
//  Linux   : NetworkManager (nmcli, sans root) si disponible, sinon wg-quick via pkexec
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VpnBackendInfo, VpnProfile, VpnStatus } from '../shared/types';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, env: { ...process.env, LC_ALL: 'C' } });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: (e as Error).message });
      return;
    }
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 120000);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: stderr + e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

export const TUNNEL_NAME_RE = /^[A-Za-z0-9_=+.-]{1,15}$/;

/** Dérive un nom d'interface valide à partir d'un libellé. */
export function suggestTunnelName(label: string): string {
  const base = label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_=+.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 15)
    .replace(/[-.]+$/, '');
  return base || 'wg-ksdb';
}

/** Vérifie qu'un texte ressemble à une configuration WireGuard et en extrait l'endpoint. */
export function parseWgConfig(text: string): { ok: boolean; endpoint?: string; error?: string } {
  if (!/^\s*\[Interface\]/im.test(text)) return { ok: false, error: 'Section [Interface] manquante' };
  if (!/^\s*PrivateKey\s*=/im.test(text)) return { ok: false, error: 'PrivateKey manquante dans [Interface]' };
  if (!/^\s*\[Peer\]/im.test(text)) return { ok: false, error: 'Section [Peer] manquante' };
  const ep = /^\s*Endpoint\s*=\s*(\S+)/im.exec(text)?.[1];
  return { ok: true, endpoint: ep };
}

const psQuote = (s: string) => "'" + s.replace(/'/g, "''") + "'";
/** Guillemets pour sh (macOS : do shell script) */
const shQuote = (s: string) => "'" + s.replace(/'/g, `'\\''`) + "'";
/** Chaîne AppleScript */
const asQuote = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
/** Les applications lancées depuis le Finder ont un PATH minimal : wg-quick a besoin du bash de Homebrew. */
const MAC_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

export class VpnManager {
  private owned = new Set<string>();
  private backendCache: VpnBackendInfo | null = null;

  constructor(
    private opts: {
      dataDir: string;
      /** Configuration en clair d'un profil (mode file) */
      readConfig: (id: string) => string | undefined;
      platform?: NodeJS.Platform;
      run?: Runner;
      exists?: (p: string) => boolean;
      /** Délai max d'attente du passage à l'état « up » */
      waitMs?: number;
    },
  ) {}

  private get platform() {
    return this.opts.platform ?? process.platform;
  }
  private get run() {
    return this.opts.run ?? defaultRunner;
  }
  private exists(p: string) {
    return (this.opts.exists ?? fs.existsSync)(p);
  }

  private vpnDir() {
    const d = path.join(this.opts.dataDir, 'vpn');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }

  /** Écrit la configuration en clair (droits 600) sous le nom attendu par WireGuard. */
  private writeConfFile(p: VpnProfile): string {
    const conf = this.opts.readConfig(p.id);
    if (!conf) throw new Error(`Aucune configuration WireGuard enregistrée pour « ${p.name} ». Importe le fichier .conf.`);
    const file = path.join(this.vpnDir(), `${p.tunnelName}.conf`);
    fs.writeFileSync(file, conf.replace(/\r?\n/g, this.platform === 'win32' ? '\r\n' : '\n'), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* Windows */
    }
    return file;
  }

  private removeConfFile(p: VpnProfile) {
    try {
      fs.rmSync(path.join(this.vpnDir(), `${p.tunnelName}.conf`), { force: true });
    } catch {
      /* ignore */
    }
  }

  // ---------------- Détection ----------------

  private wireguardExe(): string | null {
    const cands = [
      process.env['ProgramFiles'] && path.join(process.env['ProgramFiles'], 'WireGuard', 'wireguard.exe'),
      'C:\\Program Files\\WireGuard\\wireguard.exe',
    ].filter(Boolean) as string[];
    return cands.find((c) => this.exists(c)) ?? null;
  }

  private async has(cmd: string): Promise<boolean> {
    const r = await this.run('sh', ['-c', `command -v ${cmd}`], { timeoutMs: 5000 });
    return r.code === 0 && r.stdout.trim().length > 0;
  }

  private async nmRunning(): Promise<boolean> {
    if (!(await this.has('nmcli'))) return false;
    const r = await this.run('nmcli', ['-t', '-f', 'RUNNING', 'general'], { timeoutMs: 8000 });
    return r.code === 0 && /running/i.test(r.stdout);
  }

  async backend(refresh = false): Promise<VpnBackendInfo> {
    if (this.backendCache && !refresh) return this.backendCache;
    let info: VpnBackendInfo;
    if (this.platform === 'win32') {
      const exe = this.wireguardExe();
      info = exe
        ? { platform: 'win32', available: true, backend: 'wireguard-windows', detail: exe }
        : {
            platform: 'win32',
            available: false,
            backend: 'none',
            detail: 'WireGuard pour Windows introuvable. Installe-le depuis https://www.wireguard.com/install/',
          };
    } else if (this.platform === 'linux') {
      if (await this.nmRunning()) info = { platform: 'linux', available: true, backend: 'networkmanager', detail: 'NetworkManager (nmcli)' };
      else if ((await this.has('wg-quick')) && (await this.has('pkexec')))
        info = { platform: 'linux', available: true, backend: 'wg-quick', detail: 'wg-quick via pkexec' };
      else
        info = {
          platform: 'linux',
          available: false,
          backend: 'none',
          detail: 'Ni NetworkManager ni wg-quick trouvés. Installe : sudo apt install wireguard-tools',
        };
    } else if (this.platform === 'darwin') {
      const wq = this.macWgQuick();
      info = wq
        ? { platform: 'darwin', available: true, backend: 'wg-quick', detail: `${wq} (autorisation administrateur macOS) ; tunnels de l’application WireGuard via scutil` }
        : {
            platform: 'darwin',
            available: true,
            backend: 'wg-quick',
            detail: 'wg-quick introuvable : seuls les tunnels de l’application WireGuard (mode « tunnel existant ») sont utilisables. Pour un fichier .conf : brew install wireguard-tools',
          };
    } else {
      info = { platform: this.platform, available: false, backend: 'none', detail: 'Système non pris en charge pour le VPN' };
    }
    this.backendCache = info;
    return info;
  }

  // ---------------- Statut ----------------

  async status(p: VpnProfile): Promise<VpnStatus> {
    const base = { id: p.id, ownedBySession: this.owned.has(p.id) };
    try {
      if (this.platform === 'win32') {
        const r = await this.run('sc', ['query', `WireGuardTunnel$${p.tunnelName}`], { timeoutMs: 8000 });
        if (/STATE\s*:\s*4\s+RUNNING/i.test(r.stdout)) return { ...base, state: 'up' };
        if (/STATE\s*:\s*2\s+START_PENDING/i.test(r.stdout)) return { ...base, state: 'down', detail: 'démarrage…' };
        return { ...base, state: 'down' };
      }
      if (this.platform === 'linux') {
        const r = await this.run('ip', ['-o', 'link', 'show', 'dev', p.tunnelName], { timeoutMs: 5000 });
        return { ...base, state: r.code === 0 ? 'up' : 'down' };
      }
      if (this.platform === 'darwin') {
        if (p.mode === 'existing' && (await this.macNcNames()).includes(p.tunnelName)) {
          const r = await this.run('scutil', ['--nc', 'status', p.tunnelName], { timeoutMs: 8000 });
          const first = r.stdout.split('\n')[0]?.trim() ?? '';
          if (first === 'Connected') return { ...base, state: 'up' };
          if (/Connecting/i.test(first)) return { ...base, state: 'down', detail: 'connexion…' };
          return { ...base, state: 'down' };
        }
        // wg-quick (macOS) enregistre l'interface utun associée dans /var/run/wireguard/<nom>.name
        return { ...base, state: this.exists(`/var/run/wireguard/${p.tunnelName}.name`) ? 'up' : 'down' };
      }
      return { ...base, state: 'unknown' };
    } catch (e) {
      return { ...base, state: 'unknown', detail: (e as Error).message };
    }
  }

  private async waitUp(p: VpnProfile): Promise<boolean> {
    const deadline = Date.now() + (this.opts.waitMs ?? 15000);
    for (;;) {
      if ((await this.status(p)).state === 'up') return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  // ---------------- Windows (UAC) ----------------

  /** Exécute un script PowerShell en administrateur (une fenêtre UAC s'affiche). */
  private async elevatedPs(script: string): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksdb-vpn-'));
    const ps1 = path.join(dir, 'run.ps1');
    const log = path.join(dir, 'err.txt');
    fs.writeFileSync(
      ps1,
      '\ufeff' +
        `$ErrorActionPreference = 'Stop'\r\ntry {\r\n${script}\r\n  exit 0\r\n} catch {\r\n  $_ | Out-String | Out-File -Encoding utf8 ${psQuote(log)}\r\n  exit 1\r\n}\r\n`,
      'utf8',
    );
    const outer =
      `try { $p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -Wait -PassThru ` +
      `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psQuote(`"${ps1}"`)}; exit $p.ExitCode } ` +
      `catch { Write-Error $_.Exception.Message; exit 1223 }`;
    try {
      const r = await this.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], { timeoutMs: 180000 });
      if (r.code === 1223 || /canceled by the user|annulée par l.utilisateur/i.test(r.stderr))
        throw new Error('Autorisation administrateur refusée : le VPN n’a pas été modifié.');
      if (r.code !== 0) {
        let msg = '';
        try {
          msg = fs.readFileSync(log, 'utf8').replace(/^\ufeff/, '').trim();
        } catch {
          /* pas de journal */
        }
        throw new Error(msg || r.stderr.trim() || `Échec (code ${r.code})`);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  private async winStart(p: VpnProfile) {
    const exe = this.wireguardExe();
    if (!exe) throw new Error((await this.backend(true)).detail);
    const svc = `WireGuardTunnel$${p.tunnelName}`;
    let confPath: string;
    if (p.mode === 'file') confPath = this.writeConfFile(p);
    else {
      const dataDir = path.join(path.dirname(exe), 'Data', 'Configurations');
      confPath = path.join(dataDir, `${p.tunnelName}.conf.dpapi`);
    }
    const script = [
      `  $svc = Get-Service -Name ${psQuote(svc)} -ErrorAction SilentlyContinue`,
      `  if ($svc) {`,
      `    if ($svc.Status -ne 'Running') { Start-Service -Name ${psQuote(svc)} }`,
      `  } else {`,
      `    if (-not (Test-Path -LiteralPath ${psQuote(confPath)})) { throw ${psQuote(
        p.mode === 'existing'
          ? `Tunnel « ${p.tunnelName} » introuvable dans l’application WireGuard (${confPath}). Vérifie le nom exact du tunnel.`
          : `Fichier de configuration introuvable : ${confPath}`,
      )} }`,
      `    & ${psQuote(exe)} /installtunnelservice ${psQuote(confPath)}`,
      `    if ($LASTEXITCODE -ne 0) { throw "wireguard.exe a échoué (code $LASTEXITCODE)" }`,
      `  }`,
    ].join('\r\n');
    await this.elevatedPs(script);
  }

  private async winStop(p: VpnProfile) {
    const exe = this.wireguardExe();
    if (!exe) throw new Error((await this.backend(true)).detail);
    await this.elevatedPs(
      `  & ${psQuote(exe)} /uninstalltunnelservice ${psQuote(p.tunnelName)}\r\n` +
        `  if ($LASTEXITCODE -ne 0) { throw "wireguard.exe a échoué (code $LASTEXITCODE)" }`,
    );
  }

  // ---------------- Linux ----------------

  private async nmConnections(): Promise<{ name: string; type: string }[]> {
    const r = await this.run('nmcli', ['-t', '-f', 'NAME,TYPE', 'connection', 'show'], { timeoutMs: 8000 });
    if (r.code !== 0) return [];
    return r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const i = l.lastIndexOf(':');
        return { name: l.slice(0, i).replace(/\\:/g, ':'), type: l.slice(i + 1) };
      });
  }

  private async must(cmd: string, args: string[], what: string) {
    const r = await this.run(cmd, args, { timeoutMs: 120000 });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim();
      if (cmd === 'pkexec' && (r.code === 126 || r.code === 127))
        throw new Error('Autorisation administrateur refusée : le VPN n’a pas été modifié.');
      throw new Error(`${what} : ${msg || `code ${r.code}`}`);
    }
    return r;
  }

  private async linuxStart(p: VpnProfile) {
    const b = await this.backend();
    if (!b.available) throw new Error(b.detail);
    const etcConf = `/etc/wireguard/${p.tunnelName}.conf`;
    if (b.backend === 'networkmanager') {
      const conns = await this.nmConnections();
      const known = conns.some((c) => c.name === p.tunnelName && /wireguard/i.test(c.type));
      if (!known) {
        if (p.mode === 'file') {
          const file = this.writeConfFile(p);
          try {
            await this.must('nmcli', ['connection', 'import', 'type', 'wireguard', 'file', file], 'Import dans NetworkManager');
          } finally {
            this.removeConfFile(p);
          }
          await this.run('nmcli', ['connection', 'modify', p.tunnelName, 'connection.autoconnect', 'no']);
        } else if (this.exists(etcConf) && (await this.has('wg-quick'))) {
          await this.must('pkexec', ['wg-quick', 'up', p.tunnelName], 'wg-quick up');
          return;
        } else throw new Error(`Aucune connexion WireGuard « ${p.tunnelName} » dans NetworkManager ni dans /etc/wireguard.`);
      }
      await this.must('nmcli', ['connection', 'up', p.tunnelName], 'Démarrage du tunnel');
      return;
    }
    // wg-quick + pkexec
    if (p.mode === 'file') await this.must('pkexec', ['wg-quick', 'up', this.writeConfFile(p)], 'wg-quick up');
    else await this.must('pkexec', ['wg-quick', 'up', p.tunnelName], 'wg-quick up');
  }

  private async linuxStop(p: VpnProfile) {
    const b = await this.backend();
    if (b.backend === 'networkmanager') {
      const conns = await this.nmConnections();
      if (conns.some((c) => c.name === p.tunnelName && /wireguard/i.test(c.type))) {
        await this.must('nmcli', ['connection', 'down', p.tunnelName], 'Arrêt du tunnel');
        return;
      }
    }
    const file = path.join(this.vpnDir(), `${p.tunnelName}.conf`);
    const target = p.mode === 'file' && this.exists(file) ? file : p.tunnelName;
    await this.must('pkexec', ['wg-quick', 'down', target], 'wg-quick down');
  }

  // ---------------- macOS ----------------

  private macWgQuick(): string | null {
    return ['/opt/homebrew/bin/wg-quick', '/usr/local/bin/wg-quick'].find((c) => this.exists(c)) ?? null;
  }

  /** Tunnels de l'application WireGuard (et autres VPN système) connus de macOS. */
  private async macNcNames(): Promise<string[]> {
    const r = await this.run('scutil', ['--nc', 'list'], { timeoutMs: 8000 });
    if (r.code !== 0) return [];
    return [...r.stdout.matchAll(/"([^"]+)"\s+\[VPN/g)].map((m) => m[1]);
  }

  /** Exécute une commande en administrateur (fenêtre d'autorisation macOS). */
  private async macAdmin(cmd: string, what: string) {
    const script = `do shell script ${asQuote(`export PATH=${MAC_PATH}; ${cmd}`)} with administrator privileges`;
    const r = await this.run('osascript', ['-e', script], { timeoutMs: 180000 });
    if (r.code !== 0) {
      const msg = (r.stderr || r.stdout).trim();
      if (/-128|User cancel|annulé/i.test(msg)) throw new Error('Autorisation administrateur refusée : le VPN n’a pas été modifié.');
      throw new Error(`${what} : ${msg.replace(/^\d+:\d+: execution error: /, '') || `code ${r.code}`}`);
    }
  }

  private async macStart(p: VpnProfile) {
    if (p.mode === 'existing' && (await this.macNcNames()).includes(p.tunnelName)) {
      await this.must('scutil', ['--nc', 'start', p.tunnelName], 'Démarrage du tunnel');
      return;
    }
    const wq = this.macWgQuick();
    if (!wq)
      throw new Error(
        p.mode === 'existing'
          ? `Tunnel « ${p.tunnelName} » introuvable dans l’application WireGuard, et wg-quick n’est pas installé (brew install wireguard-tools).`
          : 'wg-quick introuvable. Installe les outils WireGuard : brew install wireguard-tools',
      );
    const target = p.mode === 'file' ? this.writeConfFile(p) : p.tunnelName;
    await this.macAdmin(`${shQuote(wq)} up ${shQuote(target)}`, 'wg-quick up');
  }

  private async macStop(p: VpnProfile) {
    if (p.mode === 'existing' && (await this.macNcNames()).includes(p.tunnelName)) {
      await this.must('scutil', ['--nc', 'stop', p.tunnelName], 'Arrêt du tunnel');
      return;
    }
    const wq = this.macWgQuick() ?? 'wg-quick';
    const file = path.join(this.vpnDir(), `${p.tunnelName}.conf`);
    const target = p.mode === 'file' && this.exists(file) ? file : p.tunnelName;
    await this.macAdmin(`${shQuote(wq)} down ${shQuote(target)}`, 'wg-quick down');
  }

  // ---------------- API ----------------

  async start(p: VpnProfile): Promise<VpnStatus> {
    // macOS : les tunnels de l'application WireGuard peuvent avoir n'importe quel nom (pilotés par scutil)
    const free = this.platform === 'darwin' && p.mode === 'existing' && (await this.macNcNames()).includes(p.tunnelName);
    if (!free && !TUNNEL_NAME_RE.test(p.tunnelName)) throw new Error(`Nom de tunnel invalide : « ${p.tunnelName} » (15 caractères max, lettres, chiffres, _ = + . -)`);
    if ((await this.status(p)).state === 'up') return this.status(p);
    if (this.platform === 'win32') await this.winStart(p);
    else if (this.platform === 'linux') await this.linuxStart(p);
    else if (this.platform === 'darwin') await this.macStart(p);
    else throw new Error('Système non pris en charge pour le VPN');
    this.owned.add(p.id);
    if (!(await this.waitUp(p))) throw new Error(`Le tunnel « ${p.tunnelName} » ne s’est pas activé dans le délai imparti.`);
    return this.status(p);
  }

  async stop(p: VpnProfile): Promise<VpnStatus> {
    if ((await this.status(p)).state === 'down') {
      this.owned.delete(p.id);
      return this.status(p);
    }
    if (this.platform === 'win32') await this.winStop(p);
    else if (this.platform === 'linux') await this.linuxStop(p);
    else if (this.platform === 'darwin') await this.macStop(p);
    this.owned.delete(p.id);
    if (p.mode === 'file' && this.platform !== 'win32') this.removeConfFile(p);
    return this.status(p);
  }

  /** À appeler quand la configuration d'un profil change : force la réimportation côté NetworkManager. */
  async invalidate(p: VpnProfile, previousTunnelName?: string) {
    if (this.platform !== 'linux' || p.mode !== 'file') return;
    const b = await this.backend();
    if (b.backend !== 'networkmanager') return;
    const conns = await this.nmConnections();
    for (const name of new Set([p.tunnelName, previousTunnelName].filter(Boolean) as string[])) {
      if (conns.some((c) => c.name === name && /wireguard/i.test(c.type))) {
        await this.run('nmcli', ['connection', 'down', name]);
        await this.run('nmcli', ['connection', 'delete', name]);
      }
    }
  }

  /** Arrête les tunnels démarrés pendant la session et marqués « arrêter en quittant ». */
  async stopOwned(profiles: VpnProfile[]) {
    for (const p of profiles) if (this.owned.has(p.id) && p.stopOnQuit) await this.stop(p).catch(() => {});
  }

  isOwned(id: string) {
    return this.owned.has(id);
  }
}
