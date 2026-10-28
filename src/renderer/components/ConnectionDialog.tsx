import { FolderOpen, PlugZap } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ConnectionConfig } from '../../shared/types';
import { api } from '../api';
import { connectionById, refreshConnections, setState, toast, useApp } from '../state';
import { CONNECTION_COLORS, Field, Modal } from './ui';

type Flavor = 'postgres' | 'mysql' | 'mariadb';
const DEFAULT_PORT: Record<Flavor, number> = { postgres: 5432, mysql: 3306, mariadb: 3306 };

function blank(group?: string): ConnectionConfig {
  return {
    id: '',
    name: '',
    kind: 'postgres',
    flavor: 'postgres',
    host: 'localhost',
    port: 5432,
    user: 'postgres',
    savePassword: true,
    database: '',
    group: group ?? '',
    color: CONNECTION_COLORS[0],
    readOnly: false,
    production: false,
    ssl: { mode: 'disable' },
    ssh: { enabled: false, host: '', port: 22, user: '', auth: 'password', keyPath: '' },
  };
}

export function ConnectionDialog() {
  const editing = useApp((s) => s.editingConnection);
  const connections = useApp((s) => s.connections);
  const groups = useMemo(() => [...new Set(connections.map((c) => c.group).filter(Boolean))] as string[], [connections]);
  const [cfg, setCfg] = useState<ConnectionConfig>(blank());
  const [section, setSection] = useState<'general' | 'vpn' | 'ssh' | 'ssl' | 'options'>('general');
  const vpns = useApp((s) => s.vpns);
  const groupSettings = useApp((s) => s.groups);
  const [secrets, setSecrets] = useState({ password: '', sshPassword: '', passphrase: '' });
  const [dirty, setDirty] = useState({ password: false, sshPassword: false, passphrase: false });
  const [has, setHas] = useState({ password: false, sshPassword: false, passphrase: false });
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setSection('general');
    setTest(null);
    setSecrets({ password: '', sshPassword: '', passphrase: '' });
    setDirty({ password: false, sshPassword: false, passphrase: false });
    const existing = editing.id ? connectionById(editing.id) : undefined;
    if (existing) {
      const { hasPassword, hasSshPassword, hasPassphrase, connected: _c, effectiveVpnId: _e, ...rest } = existing;
      setCfg({ ...blank(), ...rest, ssh: { ...blank().ssh, ...rest.ssh } } as ConnectionConfig);
      setHas({ password: hasPassword, sshPassword: hasSshPassword, passphrase: hasPassphrase });
    } else {
      setCfg(blank(editing.group));
      setHas({ password: false, sshPassword: false, passphrase: false });
    }
  }, [editing]);

  if (!editing) return null;
  const close = () => setState({ editingConnection: null });
  const set = (p: Partial<ConnectionConfig>) => setCfg((c) => ({ ...c, ...p }));
  const setSsh = (p: Partial<ConnectionConfig['ssh']>) => setCfg((c) => ({ ...c, ssh: { ...c.ssh, ...p } }));
  const flavor = (cfg.flavor ?? cfg.kind) as Flavor;
  const groupVpnId = cfg.group?.trim() ? groupSettings[cfg.group.trim()]?.vpnId : undefined;
  const groupVpn = vpns.find((v) => v.profile.id === groupVpnId);
  const effectiveVpn = cfg.vpnId === 'none' ? undefined : cfg.vpnId ? vpns.find((v) => v.profile.id === cfg.vpnId) : groupVpn;

  const setFlavor = (f: Flavor) => {
    const wasDefaultPort = cfg.port === DEFAULT_PORT[flavor];
    const wasDefaultUser = ['postgres', 'root', ''].includes(cfg.user);
    set({
      flavor: f,
      kind: f === 'postgres' ? 'postgres' : 'mysql',
      port: wasDefaultPort ? DEFAULT_PORT[f] : cfg.port,
      user: wasDefaultUser ? (f === 'postgres' ? 'postgres' : 'root') : cfg.user,
    });
  };

  const secret = (key: keyof typeof secrets, v: string) => {
    setSecrets((s) => ({ ...s, [key]: v }));
    setDirty((d) => ({ ...d, [key]: true }));
  };

  const build = (): ConnectionConfig => ({
    ...cfg,
    name: cfg.name.trim() || `${cfg.user}@${cfg.host}`,
    port: Number(cfg.port) || DEFAULT_PORT[flavor],
    password: dirty.password ? secrets.password : undefined,
    ssh: {
      ...cfg.ssh,
      port: Number(cfg.ssh.port) || 22,
      password: dirty.sshPassword ? secrets.sshPassword : undefined,
      passphrase: dirty.passphrase ? secrets.passphrase : undefined,
    },
  });

  const runTest = async () => {
    setBusy(true);
    setTest(null);
    try {
      const c = build();
      // test avec le mot de passe saisi même si « enregistrer » est décoché
      if (!c.savePassword && !dirty.password) c.password = '';
      const info = await api.testConnection(c);
      setTest({ ok: true, text: `Connexion réussie\n${info.version}\nUtilisateur : ${info.currentUser}` });
    } catch (e) {
      setTest({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    try {
      await api.saveConnection(build());
      await refreshConnections();
      toast(`Connexion « ${build().name} » enregistrée`, 'success');
      close();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const pickFile = async (apply: (p: string) => void, title: string) => {
    const r = await api.openDialog({ title, properties: ['openFile', 'showHiddenFiles'] });
    if (r?.[0]) apply(r[0]);
  };

  const savedPh = (k: keyof typeof has) => (has[k] ? 'Enregistré (laisser vide pour conserver)' : '');

  return (
    <Modal
      title={editing.id ? 'Modifier la connexion' : 'Nouvelle connexion'}
      onClose={close}
      wide
      footer={
        <>
          <button className="btn outline left" onClick={runTest} disabled={busy}>
            <PlugZap className={busy ? 'spin' : ''} /> Tester
          </button>
          <button className="btn outline" onClick={close}>
            Annuler
          </button>
          <button className="btn primary" onClick={save}>
            Enregistrer
          </button>
        </>
      }
    >
      <div className="dialog-tabs" role="tablist">
        {(
          [
            ['general', 'Général'],
            ['vpn', `VPN${effectiveVpn ? ' (configuré)' : ''}`],
            ['ssh', `Tunnel SSH${cfg.ssh.enabled ? ' (actif)' : ''}`],
            ['ssl', 'SSL'],
            ['options', 'Options'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" className={section === k ? 'active' : ''} onClick={() => setSection(k)}>
            {l}
          </button>
        ))}
      </div>

      {section === 'general' && (
        <div className="form-grid">
          <Field label="Type de serveur" className="full">
            <div className="seg">
              {(['postgres', 'mysql', 'mariadb'] as Flavor[]).map((f) => (
                <button key={f} className={flavor === f ? 'active' : ''} onClick={() => setFlavor(f)}>
                  {f === 'postgres' ? 'PostgreSQL' : f === 'mysql' ? 'MySQL' : 'MariaDB'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Nom de la connexion">
            <input className="input" value={cfg.name} placeholder={`${cfg.user}@${cfg.host}`} onChange={(e) => set({ name: e.target.value })} autoFocus />
          </Field>
          <Field label="Groupe (dossier)">
            <input className="input" list="conn-groups" value={cfg.group ?? ''} placeholder="ex. QOS, EFB, Clients" onChange={(e) => set({ group: e.target.value })} />
            <datalist id="conn-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </Field>
          <Field label="Hôte">
            <input className="input" value={cfg.host} onChange={(e) => set({ host: e.target.value })} />
          </Field>
          <Field label="Port">
            <input className="input" type="number" value={cfg.port} onChange={(e) => set({ port: Number(e.target.value) })} />
          </Field>
          <Field label="Utilisateur">
            <input className="input" value={cfg.user} onChange={(e) => set({ user: e.target.value })} />
          </Field>
          <Field label="Mot de passe">
            <input
              className="input"
              type="password"
              value={secrets.password}
              placeholder={savedPh('password')}
              onChange={(e) => secret('password', e.target.value)}
            />
          </Field>
          <Field label="Base par défaut" hint={flavor === 'postgres' ? 'postgres si vide' : 'facultatif'}>
            <input className="input" value={cfg.database ?? ''} onChange={(e) => set({ database: e.target.value })} />
          </Field>
          <Field label="Couleur">
            <div className="swatches" style={{ paddingTop: 4 }}>
              {CONNECTION_COLORS.map((c) => (
                <button key={c} className={cfg.color === c ? 'active' : ''} style={{ background: c }} onClick={() => set({ color: c })} aria-label={`Couleur ${c}`} />
              ))}
            </div>
          </Field>
          <label className="check full">
            <input type="checkbox" checked={cfg.savePassword} onChange={(e) => set({ savePassword: e.target.checked })} />
            Enregistrer le mot de passe (chiffré par le système)
          </label>
        </div>
      )}

      {section === 'ssh' && (
        <div className="form-grid">
          <label className="check full">
            <input type="checkbox" checked={cfg.ssh.enabled} onChange={(e) => setSsh({ enabled: e.target.checked })} />
            Passer par un tunnel SSH
          </label>
          {cfg.ssh.enabled && (
            <>
              <p className="hint full" style={{ margin: 0 }}>
                L’hôte de l’onglet Général est vu depuis le serveur SSH : mets en général <b>127.0.0.1</b>.
              </p>
              <Field label="Serveur SSH">
                <input className="input" value={cfg.ssh.host} onChange={(e) => setSsh({ host: e.target.value })} />
              </Field>
              <Field label="Port SSH">
                <input className="input" type="number" value={cfg.ssh.port} onChange={(e) => setSsh({ port: Number(e.target.value) })} />
              </Field>
              <Field label="Utilisateur SSH">
                <input className="input" value={cfg.ssh.user} onChange={(e) => setSsh({ user: e.target.value })} />
              </Field>
              <Field label="Authentification">
                <div className="seg">
                  <button className={cfg.ssh.auth === 'password' ? 'active' : ''} onClick={() => setSsh({ auth: 'password' })}>
                    Mot de passe
                  </button>
                  <button className={cfg.ssh.auth === 'key' ? 'active' : ''} onClick={() => setSsh({ auth: 'key' })}>
                    Clé privée
                  </button>
                </div>
              </Field>
              {cfg.ssh.auth === 'password' ? (
                <Field label="Mot de passe SSH" className="full">
                  <input className="input" type="password" value={secrets.sshPassword} placeholder={savedPh('sshPassword')} onChange={(e) => secret('sshPassword', e.target.value)} />
                </Field>
              ) : (
                <>
                  <Field label="Fichier de clé privée" className="full">
                    <div className="form-row">
                      <input className="input" style={{ flex: 1 }} value={cfg.ssh.keyPath ?? ''} placeholder="~/.ssh/id_ed25519" onChange={(e) => setSsh({ keyPath: e.target.value })} />
                      <button className="btn outline" onClick={() => pickFile((p) => setSsh({ keyPath: p }), 'Clé privée SSH')}>
                        <FolderOpen /> Parcourir
                      </button>
                    </div>
                  </Field>
                  <Field label="Phrase de passe (si la clé est protégée)" className="full">
                    <input className="input" type="password" value={secrets.passphrase} placeholder={savedPh('passphrase')} onChange={(e) => secret('passphrase', e.target.value)} />
                  </Field>
                </>
              )}
            </>
          )}
        </div>
      )}

      {section === 'ssl' && (
        <div className="form-grid">
          <Field label="Mode SSL" className="full">
            <div className="seg">
              {(
                [
                  ['disable', 'Désactivé'],
                  ['require', 'Requis'],
                  ['verify', 'Requis + vérifier le certificat'],
                ] as const
              ).map(([k, l]) => (
                <button key={k} className={cfg.ssl.mode === k ? 'active' : ''} onClick={() => set({ ssl: { ...cfg.ssl, mode: k } })}>
                  {l}
                </button>
              ))}
            </div>
          </Field>
          {cfg.ssl.mode === 'verify' && (
            <Field label="Certificat d’autorité (CA)" className="full">
              <div className="form-row">
                <input className="input" style={{ flex: 1 }} value={cfg.ssl.caPath ?? ''} onChange={(e) => set({ ssl: { ...cfg.ssl, caPath: e.target.value } })} />
                <button className="btn outline" onClick={() => pickFile((p) => set({ ssl: { ...cfg.ssl, caPath: p } }), 'Certificat CA')}>
                  <FolderOpen /> Parcourir
                </button>
              </div>
            </Field>
          )}
          <p className="hint full" style={{ margin: 0 }}>
            Les services managés (RDS, Azure, DigitalOcean, Supabase…) exigent en général le mode « Requis ».
          </p>
        </div>
      )}

      {section === 'vpn' && (
        <div className="form-grid">
          <Field label="VPN WireGuard à utiliser" className="full">
            <select
              className="input"
              value={cfg.vpnId ?? ''}
              onChange={(e) => set({ vpnId: e.target.value || undefined })}
            >
              <option value="">{groupVpn ? `Celui du groupe : ${groupVpn.profile.name}` : cfg.group?.trim() ? 'Celui du groupe (aucun pour l’instant)' : 'Aucun'}</option>
              {groupVpn && <option value="none">Aucun (ignorer le VPN du groupe)</option>}
              {vpns.map((v) => (
                <option key={v.profile.id} value={v.profile.id}>
                  {v.profile.name} ({v.profile.tunnelName})
                </option>
              ))}
            </select>
          </Field>
          <p className="hint full" style={{ margin: 0 }}>
            {effectiveVpn
              ? effectiveVpn.profile.autoStart
                ? `Le tunnel « ${effectiveVpn.profile.tunnelName} » sera démarré automatiquement avant d’ouvrir la connexion (et avant le test).`
                : `Le tunnel « ${effectiveVpn.profile.tunnelName} » doit être démarré à la main (démarrage automatique désactivé dans le profil).`
              : 'La connexion n’utilise pas de VPN.'}
            {' '}L’hôte de l’onglet Général est alors l’adresse du serveur à l’intérieur du VPN (ex. 10.8.0.5).
          </p>
          <div className="full">
            <button className="btn outline" onClick={() => setState({ vpnManagerOpen: true })}>
              Gérer les profils VPN…
            </button>
          </div>
        </div>
      )}

      {section === 'options' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className="check">
            <input type="checkbox" checked={!!cfg.production} onChange={(e) => set({ production: e.target.checked })} />
            <span>
              Connexion de production
              <br />
              <small className="hint">Demande confirmation avant DROP, TRUNCATE, ou DELETE/UPDATE sans WHERE.</small>
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={!!cfg.readOnly} onChange={(e) => set({ readOnly: e.target.checked })} />
            <span>
              Lecture seule
              <br />
              <small className="hint">Toutes les sessions sont ouvertes en transaction READ ONLY ; l’édition des données est désactivée.</small>
            </span>
          </label>
        </div>
      )}

      {test && <div className={`test-result ${test.ok ? 'ok' : 'err'}`}>{test.text}</div>}
    </Modal>
  );
}
