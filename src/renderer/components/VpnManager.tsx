import { FileUp, Loader2, Pencil, Play, Plus, ShieldCheck, ShieldOff, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { VpnBackendInfo, VpnProfile } from '../../shared/types';
import { api, VpnEntry } from '../api';
import { confirmDialog, refreshConnections, refreshVpns, setState, startVpn, stopVpn, toast, useApp } from '../state';
import { Field, Modal } from './ui';

export function vpnStateOf(v: VpnEntry | undefined, transient?: { state: 'starting' | 'stopping' | null }) {
  if (!v) return 'none' as const;
  if (transient?.state) return transient.state;
  return v.status.state;
}

export function VpnDot({ state, size = 8 }: { state: string; size?: number }) {
  const color =
    state === 'up' ? 'var(--ok)' : state === 'starting' || state === 'stopping' ? 'var(--ochre)' : state === 'down' ? 'var(--muted)' : 'var(--line-strong)';
  return (
    <span
      aria-hidden
      className={state === 'starting' || state === 'stopping' ? 'pulse' : ''}
      style={{ width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', flex: 'none' }}
    />
  );
}

export const VPN_STATE_LABEL: Record<string, string> = {
  up: 'actif',
  down: 'arrêté',
  starting: 'démarrage…',
  stopping: 'arrêt…',
  unknown: 'état inconnu',
  none: '',
};

export function VpnManager() {
  const open = useApp((s) => s.vpnManagerOpen);
  const vpns = useApp((s) => s.vpns);
  const transient = useApp((s) => s.vpnTransient);
  const connections = useApp((s) => s.connections);
  const groups = useApp((s) => s.groups);
  const [backend, setBackend] = useState<VpnBackendInfo | null>(null);
  const [editing, setEditing] = useState<VpnProfile | null | 'new'>(null);

  useEffect(() => {
    if (!open) return;
    refreshVpns().catch((e) => toast(e.message, 'error'));
    api.vpnBackend().then(setBackend).catch(() => {});
  }, [open]);

  if (!open) return null;
  const close = () => {
    setEditing(null);
    setState({ vpnManagerOpen: false });
  };

  if (editing) return <VpnEditor profile={editing === 'new' ? null : editing} backend={backend} onDone={() => setEditing(null)} />;

  const usage = (id: string) => {
    const g = Object.entries(groups)
      .filter(([, v]) => v.vpnId === id)
      .map(([k]) => `groupe ${k}`);
    const c = connections.filter((x) => x.vpnId === id).map((x) => x.name);
    return [...g, ...c];
  };

  return (
    <Modal
      title="VPN WireGuard"
      onClose={close}
      wide
      footer={
        <>
          <span className="hint left">{backend ? (backend.available ? `Pilotage : ${backend.detail}` : '') : ''}</span>
          <button className="btn outline" onClick={close}>
            Fermer
          </button>
          <button className="btn primary" onClick={() => setEditing('new')}>
            <Plus /> Nouveau profil
          </button>
        </>
      }
    >
      {backend && !backend.available && (
        <div className="banner warn" style={{ borderRadius: 6, marginBottom: 14 }}>
          {backend.detail}
        </div>
      )}
      {!vpns.length ? (
        <div className="empty-state" style={{ padding: '28px 10px' }}>
          <div className="inner">
            Aucun profil VPN.
            <br />
            Importe le fichier <b>.conf</b> WireGuard fourni par ton administrateur, ou indique le nom d’un tunnel déjà installé, puis associe-le à une
            connexion ou à un groupe.
          </div>
        </div>
      ) : (
        <table className="plain">
          <thead>
            <tr>
              <th style={{ width: 22 }} />
              <th>Profil</th>
              <th>Tunnel</th>
              <th>Utilisé par</th>
              <th style={{ width: 210 }} />
            </tr>
          </thead>
          <tbody>
            {vpns.map((v) => {
              const st = vpnStateOf(v, transient[v.profile.id]);
              const busy = st === 'starting' || st === 'stopping';
              const users = usage(v.profile.id);
              const err = transient[v.profile.id]?.detail;
              return (
                <tr key={v.profile.id}>
                  <td>
                    <VpnDot state={st} />
                  </td>
                  <td>
                    <div style={{ fontWeight: 500 }}>{v.profile.name}</div>
                    <div className="hint">
                      {VPN_STATE_LABEL[st]}
                      {v.profile.endpoint ? ` · ${v.profile.endpoint}` : ''}
                      {v.profile.autoStart ? ' · démarrage auto' : ''}
                    </div>
                    {err && <div style={{ color: 'var(--danger)', fontSize: 12, whiteSpace: 'pre-wrap' }}>{err}</div>}
                  </td>
                  <td className="mono">
                    {v.profile.tunnelName}
                    <div className="hint" style={{ fontFamily: 'var(--font-ui)' }}>
                      {v.profile.mode === 'file' ? 'configuration importée' : 'tunnel du système'}
                    </div>
                  </td>
                  <td className="hint">{users.length ? users.join(', ') : '—'}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {st === 'up' ? (
                      <button className="btn outline" disabled={busy} onClick={() => stopVpn(v.profile.id)}>
                        <Square /> Arrêter
                      </button>
                    ) : (
                      <button className="btn outline" disabled={busy || backend?.available === false} onClick={() => startVpn(v.profile.id)}>
                        {busy ? <Loader2 className="spin" /> : <Play />} Démarrer
                      </button>
                    )}
                    <button className="btn icon" title="Modifier" onClick={() => setEditing(v.profile)}>
                      <Pencil />
                    </button>
                    <button
                      className="btn icon"
                      title="Supprimer"
                      onClick={async () => {
                        if (
                          !(await confirmDialog(
                            `Supprimer le profil « ${v.profile.name} » ?`,
                            users.length ? `Il sera retiré de : ${users.join(', ')}.` : undefined,
                            { danger: true, confirmLabel: 'Supprimer' },
                          ))
                        )
                          return;
                        try {
                          await api.vpnDelete(v.profile.id);
                          await Promise.all([refreshVpns(), refreshConnections()]);
                        } catch (e) {
                          toast((e as Error).message, 'error');
                        }
                      }}
                    >
                      <Trash2 />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <p className="hint" style={{ marginTop: 14 }}>
        {window.ksdb.platform === 'win32'
          ? 'Windows demande une autorisation administrateur (UAC) à chaque démarrage ou arrêt d’un tunnel : c’est le service WireGuard qui crée la carte réseau.'
          : 'Avec NetworkManager, aucun mot de passe n’est demandé. Sans lui, wg-quick est lancé via pkexec et demande ton mot de passe.'}
      </p>
    </Modal>
  );
}

function VpnEditor({ profile, backend, onDone }: { profile: VpnProfile | null; backend: VpnBackendInfo | null; onDone: () => void }) {
  const isWin = window.ksdb.platform === 'win32';
  const [p, setP] = useState<VpnProfile>(
    profile ?? { id: '', name: '', mode: 'file', tunnelName: '', autoStart: true, stopOnQuit: false },
  );
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [configText, setConfigText] = useState('');
  const [paste, setPaste] = useState(false);
  const [nameTouched, setNameTouched] = useState(!!profile);
  const [saving, setSaving] = useState(false);
  const set = (x: Partial<VpnProfile>) => setP((o) => ({ ...o, ...x }));

  const pickConf = async () => {
    const f = await api.openDialog({
      title: 'Configuration WireGuard',
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: 'WireGuard (.conf)', extensions: ['conf'] },
        { name: 'Tous les fichiers', extensions: ['*'] },
      ],
    });
    if (!f?.[0]) return;
    try {
      const info = await api.vpnInspect(f[0]);
      setConfigPath(f[0]);
      setPaste(false);
      set({ endpoint: info.endpoint ?? undefined, tunnelName: nameTouched && p.tunnelName ? p.tunnelName : info.suggestedName, name: p.name || info.suggestedName });
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const source = p.mode === 'file' ? (configPath ? { configPath } : paste && configText.trim() ? { configText } : undefined) : undefined;
      await api.vpnSave(p, source);
      await refreshVpns();
      toast(`Profil VPN « ${p.name} » enregistré`, 'success');
      onDone();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={profile ? `Modifier « ${profile.name} »` : 'Nouveau profil VPN WireGuard'}
      onClose={onDone}
      wide
      footer={
        <>
          <button className="btn outline" onClick={onDone}>
            Retour
          </button>
          <button className="btn primary" disabled={saving} onClick={save}>
            Enregistrer
          </button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="Source" className="full">
          <div className="seg">
            <button className={p.mode === 'file' ? 'active' : ''} onClick={() => set({ mode: 'file' })}>
              Importer un fichier .conf
            </button>
            <button className={p.mode === 'existing' ? 'active' : ''} onClick={() => set({ mode: 'existing' })}>
              {isWin ? 'Tunnel déjà dans l’application WireGuard' : 'Tunnel déjà configuré sur ce PC'}
            </button>
          </div>
        </Field>

        {p.mode === 'file' && (
          <Field
            label="Configuration WireGuard"
            className="full"
            hint="La configuration (clé privée comprise) est chiffrée par le système dans KSDB Studio. Elle n’est écrite en clair que le temps de démarrer le tunnel."
          >
            <div className="form-row" style={{ alignItems: 'center' }}>
              <button className="btn outline" onClick={pickConf}>
                <FileUp /> Choisir le fichier .conf
              </button>
              <button className={`btn ${paste ? 'on' : ''}`} onClick={() => (setPaste(!paste), setConfigPath(null))}>
                Coller le contenu
              </button>
              <span className="hint mono" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {configPath ?? (p.hasConfig && !paste ? 'configuration enregistrée (laisser tel quel pour la conserver)' : '')}
              </span>
            </div>
            {paste && (
              <textarea
                className="input mono"
                style={{ marginTop: 8, height: 170, fontSize: 12 }}
                placeholder={'[Interface]\nPrivateKey = …\nAddress = 10.8.0.2/32\n\n[Peer]\nPublicKey = …\nAllowedIPs = 10.8.0.0/24\nEndpoint = vpn.exemple.bj:51820'}
                value={configText}
                onChange={(e) => setConfigText(e.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
        )}

        <Field label="Nom du profil">
          <input
            className="input"
            value={p.name}
            placeholder="ex. VPN QOS production"
            onChange={async (e) => {
              const name = e.target.value;
              set({ name });
              if (!nameTouched) set({ tunnelName: await api.vpnSuggestName(name) });
            }}
          />
        </Field>
        <Field
          label={p.mode === 'existing' ? (isWin ? 'Nom du tunnel dans WireGuard' : 'Nom de la connexion / interface') : 'Nom du tunnel'}
          hint={
            p.mode === 'existing'
              ? isWin
                ? 'Exactement comme affiché dans la liste de l’application WireGuard'
                : 'Nom dans NetworkManager (nmcli connection) ou fichier /etc/wireguard/<nom>.conf'
              : '15 caractères max : lettres, chiffres, _ = + . -'
          }
        >
          <input
            className="input mono"
            value={p.tunnelName}
            maxLength={15}
            onChange={(e) => {
              setNameTouched(true);
              set({ tunnelName: e.target.value });
            }}
          />
        </Field>
        {p.endpoint && (
          <div className="hint full">
            Serveur WireGuard : <span className="mono">{p.endpoint}</span>
          </div>
        )}
        <label className="check full">
          <input type="checkbox" checked={p.autoStart} onChange={(e) => set({ autoStart: e.target.checked })} />
          Démarrer automatiquement à l’ouverture d’une connexion associée
        </label>
        <label className="check full">
          <input type="checkbox" checked={p.stopOnQuit} onChange={(e) => set({ stopOnQuit: e.target.checked })} />
          Arrêter le tunnel en quittant KSDB Studio (s’il a été démarré par KSDB Studio)
        </label>
      </div>
      {backend && !backend.available && (
        <div className="banner warn" style={{ borderRadius: 6, marginTop: 14 }}>
          {backend.detail}
        </div>
      )}
    </Modal>
  );
}

/** Petite fenêtre de choix d'un VPN pour un groupe. */
export function GroupVpnDialog({ group, onClose }: { group: string; onClose: () => void }) {
  const vpns = useApp((s) => s.vpns);
  const groups = useApp((s) => s.groups);
  const [vpnId, setVpnId] = useState(groups[group]?.vpnId ?? '');
  const save = async () => {
    try {
      await api.setGroup(group, { vpnId: vpnId || undefined });
      await Promise.all([refreshVpns(), refreshConnections()]);
      toast(vpnId ? `Le groupe « ${group} » passe désormais par le VPN` : `VPN retiré du groupe « ${group} »`, 'success');
      onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <Modal
      title={`VPN du groupe « ${group} »`}
      onClose={onClose}
      footer={
        <>
          <button className="btn outline left" onClick={() => setState({ vpnManagerOpen: true })}>
            Gérer les profils VPN…
          </button>
          <button className="btn outline" onClick={onClose}>
            Annuler
          </button>
          <button className="btn primary" onClick={save}>
            Enregistrer
          </button>
        </>
      }
    >
      <p>Toutes les connexions du groupe utiliseront ce VPN, sauf celles qui en définissent un autre (ou « Aucun ») dans leurs propres réglages.</p>
      <select className="input" style={{ width: '100%' }} value={vpnId} onChange={(e) => setVpnId(e.target.value)}>
        <option value="">Aucun VPN</option>
        {vpns.map((v) => (
          <option key={v.profile.id} value={v.profile.id}>
            {v.profile.name} ({v.profile.tunnelName})
          </option>
        ))}
      </select>
      {!vpns.length && <p className="hint" style={{ marginTop: 10 }}>Crée d’abord un profil avec « Gérer les profils VPN… ».</p>}
    </Modal>
  );
}

export const VpnIcons = { ShieldCheck, ShieldOff };
