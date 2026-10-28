// Vérification des nouvelles versions publiées sur GitHub et téléchargement du bon fichier.
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateInfo } from '../shared/types';

export const REPO = 'koyaja/KSDB-Studio';
export const RELEASES_URL = `https://github.com/${REPO}/releases`;

/** Compare deux versions « 1.2.10 » / « v1.3.0 » ; > 0 si a est plus récente. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export type InstallKind = 'windows' | 'appimage' | 'deb' | 'other';

export function installKind(platform = process.platform, env = process.env): InstallKind {
  if (platform === 'win32') return 'windows';
  if (platform === 'linux') return env.APPIMAGE ? 'appimage' : 'deb';
  return 'other';
}

interface GhAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GhRelease {
  tag_name: string;
  name: string | null;
  body: string | null;
  html_url: string;
  published_at: string;
  draft: boolean;
  prerelease: boolean;
  assets: GhAsset[];
}

export function pickAsset(assets: GhAsset[], kind: InstallKind): GhAsset | undefined {
  const by = (re: RegExp) => assets.find((a) => re.test(a.name));
  if (kind === 'windows') return by(/setup.*\.exe$/i) ?? by(/\.exe$/i);
  if (kind === 'appimage') return by(/\.AppImage$/i);
  if (kind === 'deb') return by(/amd64\.deb$/i) ?? by(/\.deb$/i);
  return undefined;
}

export function toUpdateInfo(rel: GhRelease, current: string, kind: InstallKind): UpdateInfo {
  const latest = rel.tag_name.replace(/^v/i, '');
  const asset = pickAsset(rel.assets, kind);
  return {
    current,
    latest,
    available: compareVersions(latest, current) > 0,
    notes: (rel.body ?? '').trim(),
    url: rel.html_url,
    publishedAt: rel.published_at,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
    installKind: kind,
  };
}

export async function checkForUpdate(current: string, fetchImpl: typeof fetch = fetch): Promise<UpdateInfo | null> {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `KSDB-Studio/${current}` },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) return null; // aucune release publiée
  if (!res.ok) throw new Error(`GitHub a répondu ${res.status}`);
  const rel = (await res.json()) as GhRelease;
  if (rel.draft || rel.prerelease) return null;
  return toUpdateInfo(rel, current, installKind());
}

/** Télécharge un fichier en suivant la progression ; écrit d'abord dans un .part. */
export async function download(
  url: string,
  dest: string,
  onProgress: (done: number, total: number) => void,
  signal?: AbortSignal,
): Promise<string> {
  const res = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'KSDB-Studio' } });
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`);
  const total = Number(res.headers.get('content-length') ?? 0);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const out = fs.createWriteStream(part);
  let done = 0;
  let last = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      done += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (Date.now() - last > 200) {
        last = Date.now();
        onProgress(done, total);
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  if (total && done !== total) {
    fs.rmSync(part, { force: true });
    throw new Error(`Téléchargement incomplet (${done} / ${total} octets)`);
  }
  fs.renameSync(part, dest);
  if (dest.endsWith('.AppImage')) fs.chmodSync(dest, 0o755);
  onProgress(done, total || done);
  return dest;
}
