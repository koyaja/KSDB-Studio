import { CheckCircle2, Copy, Download, ExternalLink, Loader2, RefreshCw, Sparkles } from 'lucide-react';
import { ReactNode, useState } from 'react';
import type { UpdateInfo } from '../../shared/types';
import { api } from '../api';
import { getState, saveSettings, setState, toast, useApp } from '../state';
import { Logo, Modal } from './ui';

export interface DownloadState {
  state: 'idle' | 'downloading' | 'done' | 'error';
  done: number;
  total: number;
  file?: string;
  error?: string;
}

const mb = (n: number) => (n / 1024 / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Mo';

export async function checkUpdatesNow(silentIfNone = false): Promise<UpdateInfo | null> {
  setState({ updateChecking: true });
  try {
    const info = await api.checkUpdate();
    setState({ update: info, updateCheckedAt: Date.now() });
    if (info?.available) setState({ updateOpen: true, aboutOpen: false });
    else if (!silentIfNone) toast(info ? `KSDB Studio est à jour (${info.current}).` : 'Aucune version publiée pour l’instant sur GitHub.', 'success');
    return info;
  } catch (e) {
    toast(`Vérification impossible : ${(e as Error).message}`, 'error');
    return null;
  } finally {
    setState({ updateChecking: false });
  }
}

/** Pastille dans la barre du haut quand une version plus récente existe. */
export function UpdatePill() {
  const u = useApp((s) => s.update);
  const skipped = useApp((s) => s.settings.skippedVersion);
  if (!u?.available || skipped === u.latest) return null;
  return (
    <button className="btn update-pill" onClick={() => setState({ updateOpen: true })} title={`Version ${u.latest} disponible`}>
      <Sparkles /> Mise à jour {u.latest}
    </button>
  );
}

export function UpdateDialog() {
  const open = useApp((s) => s.updateOpen);
  const u = useApp((s) => s.update);
  const dl = useApp((s) => s.download);
  const settings = useApp((s) => s.settings);
  if (!open || !u) return null;
  const close = () => setState({ updateOpen: false });

  const start = async () => {
    setState({ download: { state: 'downloading', done: 0, total: u.asset?.size ?? 0 } });
    try {
      const file = await api.downloadUpdate();
      setState({ download: { state: 'done', done: u.asset?.size ?? 0, total: u.asset?.size ?? 0, file } });
    } catch (e) {
      const msg = (e as Error).message;
      setState({ download: { state: /abort/i.test(msg) ? 'idle' : 'error', done: 0, total: 0, error: msg } });
    }
  };

  const install = async () => {
    if (!dl.file) return;
    try {
      const r = await api.installUpdate(dl.file);
      if (r === 'manual') toast('Fichier ouvert dans ton dossier Téléchargements.');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const debCmd = dl.file ? `sudo apt install "${dl.file}"` : '';
  const pct = dl.total ? Math.round((dl.done / dl.total) * 100) : null;
  const kind = u.installKind;

  return (
    <Modal
      title={u.available ? `KSDB Studio ${u.latest} est disponible` : `KSDB Studio est à jour`}
      onClose={close}
      wide
      footer={
        <>
          <button className="btn outline left" onClick={() => api.openExternal(u.url)}>
            <ExternalLink /> Voir sur GitHub
          </button>
          {u.available && dl.state !== 'done' && (
            <button
              className="btn outline"
              onClick={() => {
                saveSettings({ ...settings, skippedVersion: u.latest });
                close();
              }}
            >
              Ignorer cette version
            </button>
          )}
          <button className="btn outline" onClick={close}>
            Plus tard
          </button>
          {u.available && u.asset && dl.state !== 'done' && (
            <button className="btn primary" disabled={dl.state === 'downloading'} onClick={start}>
              {dl.state === 'downloading' ? <Loader2 className="spin" /> : <Download />}
              {kind === 'deb' ? 'Télécharger le .deb' : 'Télécharger et installer'}
            </button>
          )}
          {dl.state === 'done' && kind === 'windows' && (
            <button className="btn primary" onClick={install}>
              Installer maintenant
            </button>
          )}
          {dl.state === 'done' && kind === 'appimage' && (
            <button className="btn primary" onClick={install}>
              Remplacer et redémarrer
            </button>
          )}
        </>
      }
    >
      <p>
        Version installée : <b>{u.current}</b> · nouvelle version : <b>{u.latest}</b>
        {u.publishedAt ? ` · publiée le ${new Date(u.publishedAt).toLocaleDateString('fr-FR')}` : ''}
      </p>
      {u.notes && <ReleaseNotes text={u.notes} />}
      {!u.asset && u.available && (
        <div className="banner warn" style={{ borderRadius: 6, marginTop: 12 }}>
          Les fichiers de cette version ne sont pas encore disponibles pour ton système (la compilation est peut-être en cours). Réessaie dans quelques minutes ou ouvre la page GitHub.
        </div>
      )}
      {dl.state === 'downloading' && (
        <div style={{ marginTop: 14 }}>
          <div className={`progress ${pct === null ? 'indeterminate' : ''}`}>
            <div style={pct !== null ? { width: `${pct}%` } : undefined} />
          </div>
          <div className="hint" style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>
              {u.asset?.name} · {mb(dl.done)}
              {dl.total ? ` / ${mb(dl.total)}` : ''}
            </span>
            <a href="#" style={{ color: 'var(--accent)' }} onClick={(e) => (e.preventDefault(), api.cancelDownload())}>
              Annuler
            </a>
          </div>
        </div>
      )}
      {dl.state === 'error' && <div className="banner err" style={{ borderRadius: 6, marginTop: 12 }}>{dl.error}</div>}
      {dl.state === 'done' && (
        <div className="test-result ok" style={{ marginTop: 14 }}>
          <CheckCircle2 style={{ width: 14, height: 14, verticalAlign: -2 }} /> Téléchargé : {dl.file}
          {kind === 'windows' && '\nL’installateur va s’ouvrir et KSDB Studio se fermera. Tes connexions et réglages sont conservés.'}
          {kind === 'appimage' && '\nL’AppImage actuelle sera remplacée puis KSDB Studio redémarrera.'}
        </div>
      )}
      {dl.state === 'done' && kind === 'deb' && (
        <div style={{ marginTop: 12 }}>
          <p style={{ marginBottom: 6 }}>Installe-la avec :</p>
          <div className="form-row" style={{ alignItems: 'center' }}>
            <pre className="sql-preview" style={{ flex: 1, margin: 0 }}>{debCmd}</pre>
            <button className="btn outline" onClick={() => navigator.clipboard.writeText(debCmd).then(() => toast('Commande copiée'))}>
              <Copy /> Copier
            </button>
          </div>
          <p className="hint" style={{ marginTop: 6 }}>Puis relance KSDB Studio. Tes connexions et réglages sont conservés.</p>
        </div>
      )}
    </Modal>
  );
}

export function AboutDialog() {
  const open = useApp((s) => s.aboutOpen);
  const info = useApp((s) => s.appInfo);
  const settings = useApp((s) => s.settings);
  const update = useApp((s) => s.update);
  const checking = useApp((s) => s.updateChecking);
  const checkedAt = useApp((s) => s.updateCheckedAt);
  const [copied, setCopied] = useState(false);
  if (!open || !info) return null;
  const close = () => setState({ aboutOpen: false });
  const details = `KSDB Studio ${info.version}\n${info.platform} ${info.arch} (${info.installKind})\nElectron ${info.electron} · Chromium ${info.chrome} · Node ${info.node}`;
  return (
    <Modal
      title="À propos"
      onClose={close}
      footer={
        <>
          <button className="btn outline left" onClick={() => api.openExternal(info.releasesUrl.replace(/\/releases$/, ''))}>
            <ExternalLink /> GitHub
          </button>
          <button className="btn outline" onClick={close}>
            Fermer
          </button>
          <button className="btn primary" disabled={checking} onClick={() => checkUpdatesNow()}>
            {checking ? <Loader2 className="spin" /> : <RefreshCw />} Rechercher des mises à jour
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 14 }}>
        <div style={{ transform: 'scale(2.1)', margin: '0 12px' }}>
          <Logo />
        </div>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>KSDB Studio</div>
          <div className="hint">Version {info.version}</div>
        </div>
      </div>
      {update && (
        <p>
          {update.available ? (
            <a href="#" style={{ color: 'var(--accent)' }} onClick={(e) => (e.preventDefault(), close(), setState({ updateOpen: true }))}>
              La version {update.latest} est disponible.
            </a>
          ) : (
            `Tu as la dernière version.`
          )}
          {checkedAt ? <span className="hint"> Vérifié à {new Date(checkedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.</span> : null}
        </p>
      )}
      <label className="check" style={{ marginBottom: 12 }}>
        <input type="checkbox" checked={settings.checkUpdates !== false} onChange={(e) => saveSettings({ ...getState().settings, checkUpdates: e.target.checked })} />
        Me prévenir quand une nouvelle version est publiée
      </label>
      <pre className="sql-preview" style={{ position: 'relative' }}>
        {details}
        {'\n'}Données : {info.dataDir}
      </pre>
      <button
        className="btn"
        style={{ marginTop: 6 }}
        onClick={() => navigator.clipboard.writeText(details).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
      >
        <Copy /> {copied ? 'Copié' : 'Copier les informations'}
      </button>
    </Modal>
  );
}

/** Rendu minimal du markdown des notes de version (titres, listes, gras, code). */
function ReleaseNotes({ text }: { text: string }) {
  const inline = (s: string) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
    );
  const blocks: ReactNode[] = [];
  let list: string[] = [];
  const flush = () => {
    if (list.length) blocks.push(<ul key={blocks.length}>{list.map((l, i) => <li key={i}>{inline(l)}</li>)}</ul>);
    list = [];
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      list.push(li[1]);
      continue;
    }
    flush();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) blocks.push(<h4 key={blocks.length}>{inline(h[1])}</h4>);
    else if (line.trim()) blocks.push(<p key={blocks.length}>{inline(line)}</p>);
  }
  flush();
  return <div className="release-notes">{blocks}</div>;
}
