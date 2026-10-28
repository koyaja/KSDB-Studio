// Tests du pilotage WireGuard avec des commandes système simulées (Windows + Linux).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { VpnProfile } from '../shared/types';
import { parseWgConfig, RunResult, suggestTunnelName, VpnManager } from '../main/vpn';

const CONF = `[Interface]
PrivateKey = aGVsbG8gd29ybGQgaGVsbG8gd29ybGQgaGVsbG8gd28=
Address = 10.8.0.2/32
DNS = 1.1.1.1

[Peer]
PublicKey = c2VydmVyIHNlcnZlciBzZXJ2ZXIgc2VydmVyIHNlcnY=
AllowedIPs = 10.8.0.0/24
Endpoint = vpn.qos.bj:51820
PersistentKeepalive = 25
`;

let failed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(e as Error).stack?.split('\n').slice(0, 4).join('\n    ')}`);
  }
}

const profile = (p: Partial<VpnProfile> = {}): VpnProfile => ({
  id: 'v1',
  name: 'VPN QOS',
  mode: 'file',
  tunnelName: 'wg-qos',
  stopOnQuit: false,
  autoStart: true,
  ...p,
});

/** Simulateur de système : enregistre les appels et maintient l'état des interfaces. */
function fakeLinux(opts: { nm: boolean; wgQuick?: boolean; pkexecDenied?: boolean; nmConns?: string[] }) {
  const calls: string[] = [];
  const up = new Set<string>();
  const nm = new Set(opts.nmConns ?? []);
  const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'sh') {
      const tool = args[1].split(' ').pop()!;
      const avail = { nmcli: opts.nm, 'wg-quick': opts.wgQuick ?? true, pkexec: true }[tool];
      return avail ? ok(`/usr/bin/${tool}\n`) : { code: 1, stdout: '', stderr: '' };
    }
    if (cmd === 'nmcli' && args[0] === '-t' && args[2] === 'RUNNING') return ok('running\n');
    if (cmd === 'nmcli' && args.join(' ') === '-t -f NAME,TYPE connection show')
      return ok([...nm].map((n) => `${n}:wireguard`).join('\n') + '\nWired connection 1:802-3-ethernet\n');
    if (cmd === 'nmcli' && args[1] === 'import') {
      const file = args[args.length - 1];
      assert.ok(fs.existsSync(file), 'le .conf doit exister pendant l’import');
      // droits Unix : sans objet sous Windows
      if (process.platform !== 'win32') assert.equal((fs.statSync(file).mode & 0o777).toString(8), '600');
      nm.add(path.basename(file, '.conf'));
      return ok();
    }
    if (cmd === 'nmcli' && args[1] === 'up') {
      up.add(args[2]);
      return ok();
    }
    if (cmd === 'nmcli' && args[1] === 'down') {
      up.delete(args[2]);
      return ok();
    }
    if (cmd === 'nmcli' && args[1] === 'delete') {
      nm.delete(args[2]);
      return ok();
    }
    if (cmd === 'nmcli') return ok();
    if (cmd === 'pkexec') {
      if (opts.pkexecDenied) return { code: 126, stdout: '', stderr: 'Not authorized' };
      const target = path.basename(args[2], '.conf');
      if (args[1] === 'up') up.add(target);
      else up.delete(target);
      return ok();
    }
    if (cmd === 'ip') return up.has(args[4]) ? ok(`5: ${args[4]}: <POINTOPOINT,NOARP,UP>`) : { code: 1, stdout: '', stderr: 'does not exist' };
    return { code: 127, stdout: '', stderr: 'unknown ' + cmd };
  };
  return { run, calls, up, nm };
}

function fakeWindows(opts: { uacDenied?: boolean; existingDpapi?: boolean } = {}) {
  const calls: string[] = [];
  const running = new Set<string>();
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push([cmd, ...args].join(' '));
    if (cmd === 'sc') {
      const name = args[1].replace('WireGuardTunnel$', '');
      return running.has(name)
        ? { code: 0, stdout: `SERVICE_NAME: ${args[1]}\n        STATE              : 4  RUNNING\n`, stderr: '' }
        : { code: 1060, stdout: '[SC] EnumQueryServicesStatus:OpenService FAILED 1060', stderr: '' };
    }
    if (cmd === 'powershell.exe') {
      if (opts.uacDenied) return { code: 1223, stdout: '', stderr: 'The operation was canceled by the user.' };
      // retrouver le script élevé et en vérifier le contenu
      const m = /"([^"]+run\.ps1)"/.exec(args.join(' '));
      assert.ok(m, 'chemin du script élevé');
      const script = fs.readFileSync(m![1], 'utf8');
      const install = /\/installtunnelservice '([^']+)'/.exec(script);
      const uninstall = /\/uninstalltunnelservice '([^']+)'/.exec(script);
      if (install) {
        if (install[1].endsWith('.dpapi') && !opts.existingDpapi) return { code: 1, stdout: '', stderr: 'introuvable' };
        if (!install[1].endsWith('.dpapi')) assert.match(fs.readFileSync(install[1], 'utf8'), /\[Interface\]\r\n/);
        running.add(path.basename(install[1]).replace(/\.conf(\.dpapi)?$/, ''));
      }
      if (uninstall) running.delete(uninstall[1]);
      return { code: 0, stdout: '', stderr: '' };
    }
    return { code: 127, stdout: '', stderr: '' };
  };
  return { run, calls, running };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksdb-vpn-test-'));
  const readConfig = () => CONF;

  console.log('Configuration');
  await t('lecture d’un .conf valide', () => {
    const r = parseWgConfig(CONF);
    assert.equal(r.ok, true);
    assert.equal(r.endpoint, 'vpn.qos.bj:51820');
  });
  await t('rejet d’un fichier qui n’est pas WireGuard', () => {
    assert.equal(parseWgConfig('client\nremote x 1194').ok, false);
    assert.match(parseWgConfig('[Interface]\nAddress=1\n[Peer]').error!, /PrivateKey/);
  });
  await t('nom de tunnel dérivé (accents, espaces, 15 car.)', () => {
    assert.equal(suggestTunnelName('Bénin Prod QOS – serveurs'), 'Benin-Prod-QOS');
    assert.ok(suggestTunnelName('x'.repeat(40)).length <= 15);
  });

  console.log('Linux + NetworkManager');
  await t('démarrage : import nmcli (fichier 600 supprimé ensuite), autoconnect off, up', async () => {
    const f = fakeLinux({ nm: true });
    const vm = new VpnManager({ dataDir, readConfig, platform: 'linux', run: f.run, waitMs: 2000 });
    const st = await vm.start(profile());
    assert.equal(st.state, 'up');
    assert.ok(st.ownedBySession);
    assert.ok(f.calls.some((c) => c.startsWith('nmcli connection import type wireguard file')));
    assert.ok(f.calls.includes('nmcli connection modify wg-qos connection.autoconnect no'));
    assert.ok(f.calls.includes('nmcli connection up wg-qos'));
    assert.ok(!fs.existsSync(path.join(dataDir, 'vpn', 'wg-qos.conf')), 'clé privée non laissée sur disque');
    assert.ok(!f.calls.some((c) => c.startsWith('pkexec')), 'pas de root avec NetworkManager');
    // second démarrage : rien à faire
    const n = f.calls.length;
    await vm.start(profile());
    assert.ok(!f.calls.slice(n).some((c) => c.includes('import')));
    await vm.stop(profile());
    assert.ok(f.calls.includes('nmcli connection down wg-qos'));
    assert.equal((await vm.status(profile())).state, 'down');
  });
  await t('connexion NetworkManager déjà existante : simple up', async () => {
    const f = fakeLinux({ nm: true, nmConns: ['bureau'] });
    const vm = new VpnManager({ dataDir, readConfig, platform: 'linux', run: f.run, waitMs: 2000 });
    await vm.start(profile({ mode: 'existing', tunnelName: 'bureau' }));
    assert.ok(!f.calls.some((c) => c.includes('import')));
    assert.ok(f.calls.includes('nmcli connection up bureau'));
  });
  await t('changement de configuration : la connexion NM est supprimée pour réimport', async () => {
    const f = fakeLinux({ nm: true, nmConns: ['wg-qos'] });
    const vm = new VpnManager({ dataDir, readConfig, platform: 'linux', run: f.run, waitMs: 2000 });
    await vm.invalidate(profile());
    assert.ok(f.calls.includes('nmcli connection delete wg-qos'));
  });

  console.log('Linux sans NetworkManager (wg-quick)');
  await t('démarrage / arrêt via pkexec wg-quick', async () => {
    const f = fakeLinux({ nm: false });
    const vm = new VpnManager({ dataDir, readConfig, platform: 'linux', run: f.run, waitMs: 2000 });
    assert.equal((await vm.backend()).backend, 'wg-quick');
    await vm.start(profile());
    assert.ok(f.calls.some((c) => /^pkexec wg-quick up .*wg-qos\.conf$/.test(c)));
    await vm.stop(profile());
    assert.ok(f.calls.some((c) => /^pkexec wg-quick down .*wg-qos\.conf$/.test(c)));
    assert.ok(!fs.existsSync(path.join(dataDir, 'vpn', 'wg-qos.conf')));
  });
  await t('authentification pkexec refusée : message clair', async () => {
    const f = fakeLinux({ nm: false, pkexecDenied: true });
    const vm = new VpnManager({ dataDir, readConfig, platform: 'linux', run: f.run, waitMs: 500 });
    await assert.rejects(vm.start(profile()), /Autorisation administrateur refusée/);
  });
  await t('aucun outil disponible : explication', async () => {
    const f = fakeLinux({ nm: false, wgQuick: false });
    const vm = new VpnManager({ dataDir, readConfig, platform: 'linux', run: f.run, waitMs: 500 });
    await assert.rejects(vm.start(profile()), /wireguard-tools/);
  });

  console.log('Windows');
  const exists = (p: string) => /wireguard\.exe$/i.test(p);
  await t('démarrage : installtunnelservice élevé avec .conf CRLF, statut via sc', async () => {
    const f = fakeWindows();
    const vm = new VpnManager({ dataDir, readConfig, platform: 'win32', run: f.run, exists, waitMs: 2000 });
    const st = await vm.start(profile());
    assert.equal(st.state, 'up');
    assert.ok(f.calls.some((c) => c.startsWith('powershell.exe') && c.includes('-Verb RunAs')));
    await vm.stop(profile());
    assert.equal(f.running.size, 0);
  });
  await t('tunnel existant de l’application WireGuard (.conf.dpapi)', async () => {
    const f = fakeWindows({ existingDpapi: true });
    const vm = new VpnManager({ dataDir, readConfig, platform: 'win32', run: f.run, exists, waitMs: 2000 });
    const st = await vm.start(profile({ mode: 'existing', tunnelName: 'Bureau' }));
    assert.equal(st.state, 'up');
    assert.ok(f.running.has('Bureau'));
  });
  await t('UAC refusé : message clair, rien de démarré', async () => {
    const f = fakeWindows({ uacDenied: true });
    const vm = new VpnManager({ dataDir, readConfig, platform: 'win32', run: f.run, exists, waitMs: 500 });
    await assert.rejects(vm.start(profile()), /Autorisation administrateur refusée/);
    assert.equal(vm.isOwned('v1'), false);
  });
  await t('WireGuard non installé', async () => {
    const f = fakeWindows();
    const vm = new VpnManager({ dataDir, readConfig, platform: 'win32', run: f.run, exists: () => false, waitMs: 500 });
    await assert.rejects(vm.start(profile()), /wireguard\.com\/install/);
  });
  await t('nom de tunnel invalide refusé', async () => {
    const vm = new VpnManager({ dataDir, readConfig, platform: 'win32', run: fakeWindows().run, exists });
    await assert.rejects(vm.start(profile({ tunnelName: 'nom avec espaces' })), /invalide/);
  });
  await t('arrêt en quittant : seulement les tunnels démarrés par KSDB et marqués', async () => {
    const f = fakeWindows();
    const vm = new VpnManager({ dataDir, readConfig, platform: 'win32', run: f.run, exists, waitMs: 2000 });
    const a = profile({ id: 'a', tunnelName: 'a', stopOnQuit: true });
    const b = profile({ id: 'b', tunnelName: 'b', stopOnQuit: false });
    await vm.start(a);
    await vm.start(b);
    f.running.add('externe');
    await vm.stopOwned([a, b, profile({ id: 'c', tunnelName: 'externe', stopOnQuit: true })]);
    assert.deepEqual([...f.running].sort(), ['b', 'externe']);
  });

  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log(failed ? `\n${failed} test(s) VPN en échec` : '\nTous les tests VPN passent');
  process.exit(failed ? 1 : 0);
}

main();
