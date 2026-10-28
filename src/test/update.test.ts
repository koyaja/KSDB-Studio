// Tests de la détection des mises à jour.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { checkForUpdate, compareVersions, download, installKind, pickAsset, toUpdateInfo } from '../main/update';

let failed = 0;
async function t(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(e as Error).stack?.split('\n').slice(0, 3).join('\n    ')}`);
  }
}

const assets = [
  { name: 'KSDB-Studio-Setup-1.4.0.exe', browser_download_url: 'https://x/setup.exe', size: 10 },
  { name: 'KSDB-Studio-Setup-1.4.0.exe.blockmap', browser_download_url: 'https://x/b', size: 1 },
  { name: 'KSDB-Studio-1.4.0-linux-x86_64.AppImage', browser_download_url: 'https://x/a', size: 20 },
  { name: 'KSDB-Studio-1.4.0-linux-amd64.deb', browser_download_url: 'https://x/d', size: 30 },
];
const release = {
  tag_name: 'v1.4.0',
  name: 'KSDB Studio 1.4.0',
  body: '- Comparaison de schémas',
  html_url: 'https://github.com/koyaja/KSDB-Studio/releases/tag/v1.4.0',
  published_at: '2026-11-02T10:00:00Z',
  draft: false,
  prerelease: false,
  assets,
};

async function main() {
  console.log('Mises à jour');
  await t('comparaison de versions', () => {
    assert.ok(compareVersions('1.4.0', '1.3.0') > 0);
    assert.ok(compareVersions('v1.10.0', '1.9.9') > 0);
    assert.equal(compareVersions('1.3.0', 'v1.3.0'), 0);
    assert.ok(compareVersions('1.3.0', '1.3.1') < 0);
    assert.ok(compareVersions('2.0', '1.99.99') > 0);
  });
  await t('type d’installation', () => {
    assert.equal(installKind('win32', {}), 'windows');
    assert.equal(installKind('linux', { APPIMAGE: '/opt/x.AppImage' }), 'appimage');
    assert.equal(installKind('linux', {}), 'deb');
  });
  await t('choix du bon fichier selon le système', () => {
    assert.equal(pickAsset(assets, 'windows')!.name, 'KSDB-Studio-Setup-1.4.0.exe');
    assert.equal(pickAsset(assets, 'appimage')!.name, 'KSDB-Studio-1.4.0-linux-x86_64.AppImage');
    assert.equal(pickAsset(assets, 'deb')!.name, 'KSDB-Studio-1.4.0-linux-amd64.deb');
    assert.equal(pickAsset([], 'deb'), undefined);
  });
  await t('nouvelle version détectée', () => {
    const u = toUpdateInfo(release, '1.3.0', 'deb');
    assert.equal(u.available, true);
    assert.equal(u.latest, '1.4.0');
    assert.equal(u.asset!.url, 'https://x/d');
  });
  await t('déjà à jour', () => {
    assert.equal(toUpdateInfo(release, '1.4.0', 'windows').available, false);
    assert.equal(toUpdateInfo(release, '1.5.0', 'windows').available, false);
  });
  await t('appel GitHub : release, 404 et brouillon', async () => {
    const mk = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
    const u = await checkForUpdate('1.3.0', mk(200, release));
    assert.equal(u!.available, true);
    assert.equal(await checkForUpdate('1.3.0', mk(404, {})), null);
    assert.equal(await checkForUpdate('1.3.0', mk(200, { ...release, prerelease: true })), null);
    await assert.rejects(checkForUpdate('1.3.0', mk(403, {})), /403/);
  });
  await t('téléchargement avec progression et vérification de taille', async () => {
    const payload = Buffer.alloc(3 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      if (req.url === '/court') {
        res.writeHead(200, { 'content-length': String(payload.length) });
        res.end(payload.subarray(0, 1000));
        res.destroy();
        return;
      }
      res.writeHead(200, { 'content-length': String(payload.length) });
      res.end(payload);
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ksdb-upd-'));
    try {
      let last = 0;
      const f = await download(`http://127.0.0.1:${port}/ok`, path.join(dir, 'a.AppImage'), (d) => (last = d));
      assert.equal(fs.statSync(f).size, payload.length);
      assert.equal(last, payload.length);
      assert.equal((fs.statSync(f).mode & 0o111) !== 0, true, 'AppImage exécutable');
      await assert.rejects(download(`http://127.0.0.1:${port}/court`, path.join(dir, 'b.deb'), () => {}));
      assert.ok(!fs.existsSync(path.join(dir, 'b.deb')) && !fs.existsSync(path.join(dir, 'b.deb.part')), 'pas de fichier partiel');
    } finally {
      srv.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  console.log(failed ? `\n${failed} test(s) en échec` : '\nTous les tests de mise à jour passent');
  process.exit(failed ? 1 : 0);
}

main();
