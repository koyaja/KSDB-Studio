import {
  AlertTriangle,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Lock,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Shield,
  Trash2,
  User,
  Users,
  Wand2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  accountKey,
  buildRoleScript,
  defaultPrivilegesScript,
  dropRoleScript,
  emptyRole,
  Flavor,
  generatePassword,
  presetPrivileges,
  Preset,
  PRESETS,
  PRIV_SHORT,
  privilegeSet,
  PrivObject,
  PrivObjectType,
  RoleDetail,
  RoleDraft,
  RoleInfo,
} from '../../shared/roles';
import type { DbKind } from '../../shared/types';
import { api } from '../api';
import { Field, Modal } from '../components/ui';
import { confirmDialog, ensureConnected, newQueryTab, Tab, toast, updateTab, useApp } from '../state';

type UTab = Extract<Tab, { kind: 'users' }>;
type Sub = 'general' | 'privs' | 'sql';

const TYPE_LABEL: Record<PrivObjectType, string> = {
  global: 'Serveur',
  database: 'Base',
  schema: 'Schéma',
  table: 'Table',
  view: 'Vue',
  sequence: 'Séquence',
  function: 'Fonction',
  procedure: 'Procédure',
};

interface Section {
  id: string;
  title: string;
  hint?: string;
  rows: PrivObject[];
  columns: string[];
  /** affichage en pastilles (beaucoup de droits) */
  chips?: boolean;
  /** PG : schéma concerné (droits par défaut) */
  schema?: string;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function RoleIcon({ r }: { r: RoleInfo }) {
  return r.isRole ? <Users className="usr-ico role" /> : <User className={`usr-ico ${r.superuser ? 'super' : ''}`} />;
}

export function UsersTab({ tab, active }: { tab: UTab; active: boolean }) {
  const conn = useApp((s) => s.connections.find((c) => c.id === tab.connectionId));
  const kind: DbKind = conn?.kind ?? 'postgres';
  const pg = kind === 'postgres';
  const [dbs, setDbs] = useState<string[]>([]);
  const [roles, setRoles] = useState<RoleInfo[] | null>(null);
  const [flavor, setFlavor] = useState<Flavor>('postgres');
  const [currentUser, setCurrentUser] = useState('');
  const [listError, setListError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showSystem, setShowSystem] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<RoleDetail | null>(null);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [objects, setObjects] = useState<PrivObject[]>([]);
  const [extra, setExtra] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sub, setSub] = useState<Sub>('general');
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [scopeSchema, setScopeSchema] = useState('public');
  const [filter, setFilter] = useState('');
  const [dropOpen, setDropOpen] = useState(false);

  const isNew = !!draft && !detail;

  // ---------- chargement ----------
  const loadList = async () => {
    if (!(await ensureConnected(tab.connectionId))) return;
    setListError(null);
    try {
      const r = await api.rolesList(tab.connectionId, tab.database);
      setRoles(r.roles);
      setFlavor(r.flavor);
      setCurrentUser(r.currentUser);
      return r.roles;
    } catch (e) {
      setListError((e as Error).message);
    }
  };

  useEffect(() => {
    if (!conn?.connected) return;
    api.databases(tab.connectionId).then(setDbs).catch(() => {});
  }, [conn?.connected, tab.connectionId]);

  useEffect(() => {
    if (conn?.connected || roles === null) loadList();
  }, [tab.connectionId, tab.database, conn?.connected]);

  const loadDetail = async (key: string) => {
    const r = roles?.find((x) => accountKey(x.name, x.host) === key);
    if (!r) return;
    setLoading(true);
    setError(null);
    try {
      const d = await api.roleDetail(tab.connectionId, tab.database, r.name, r.host);
      setDetail(d);
      setDraft({ ...d.role, password: '' });
      setObjects(d.objects.map((o) => ({ ...o, privileges: [...o.privileges] })));
      setExtra([]);
      setShowPw(false);
    } catch (e) {
      setError((e as Error).message);
      setDetail(null);
      setDraft(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (selected && roles) loadDetail(selected);
  }, [selected, tab.database]);

  const startNew = (isRole: boolean) => {
    setSelected(null);
    setDetail(null);
    const d = emptyRole(kind, isRole);
    if (kind === 'mysql' && isRole && flavor === 'mysql') d.host = '%';
    setDraft({ ...d, password: isRole ? '' : generatePassword() });
    setObjects([]);
    setExtra([]);
    setSub('general');
    setShowPw(true);
    setError(null);
  };

  // ---------- script ----------
  const opts = { flavor };
  const script = useMemo(() => {
    if (!draft || !draft.name.trim()) return [];
    try {
      return [...buildRoleScript(kind, detail, draft, objects, { ...opts, mask: true }), ...extra];
    } catch {
      return [];
    }
  }, [draft, detail, objects, extra, kind, flavor]);

  const dirty = script.length > 0;

  const apply = async () => {
    if (!draft || !conn) return;
    if (!draft.name.trim()) return setError('Donne un nom au compte.');
    if (isNew && !draft.isRole && kind === 'mysql' && !draft.password) {
      if (!(await confirmDialog('Créer un compte sans mot de passe ?', 'N’importe qui pourra se connecter avec ce nom depuis les hôtes autorisés.', { danger: true, confirmLabel: 'Créer quand même' }))) return;
    }
    const real = [...buildRoleScript(kind, detail, draft, objects, opts), ...extra];
    const risky = [
      conn.production ? '⚠ Connexion de PRODUCTION.' : '',
      draft.superuser && !detail?.role.superuser ? '⚠ Le compte devient superutilisateur : il aura tous les droits sur le serveur.' : '',
      detail && detail.role.name === currentUser && script.some((s) => /REVOKE|NOSUPERUSER|NOLOGIN|RENAME|ACCOUNT LOCK/.test(s))
        ? '⚠ Tu modifies le compte avec lequel tu es connecté : tu pourrais perdre l’accès.'
        : '',
      pg ? 'Le script est exécuté dans une transaction : en cas d’erreur, rien n’est appliqué.' : 'MySQL applique chaque instruction immédiatement : en cas d’erreur, les précédentes restent appliquées.',
    ].filter(Boolean);
    if (!(await confirmDialog(`Appliquer ${real.length} instruction(s) ?`, risky.join('\n\n'), { danger: risky.length > 1, confirmLabel: 'Appliquer' }))) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.rolesApply(tab.connectionId, tab.database, real);
      if (r.error) {
        setError(`${r.error}\n\nInstruction : ${r.statement?.replace(/(PASSWORD|IDENTIFIED BY)\s+'[^']*'/gi, "$1 '••••••••'")}${pg ? '\n\nTransaction annulée : rien n’a été modifié.' : r.done ? `\n\n${r.done} instruction(s) déjà appliquée(s).` : ''}`);
        return;
      }
      toast(isNew ? `Compte ${draft.name} créé` : `Compte ${draft.name} mis à jour`, 'success');
      const list = await loadList();
      const key = accountKey(draft.name, draft.host);
      const found = list?.find((x) => accountKey(x.name, x.host) === key) ?? list?.find((x) => x.name === draft.name);
      if (found) {
        const k = accountKey(found.name, found.host);
        if (k === selected) await loadDetail(k);
        else setSelected(k);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const reset = () => {
    if (detail) {
      setDraft({ ...detail.role, password: '' });
      setObjects(detail.objects.map((o) => ({ ...o, privileges: [...o.privileges] })));
    } else setDraft(null);
    setExtra([]);
    setError(null);
  };

  // ---------- liste ----------
  const visibleRoles = useMemo(() => {
    const q = search.toLowerCase();
    return (roles ?? []).filter((r) => (showSystem || !r.system) && (!q || accountKey(r.name, r.host).toLowerCase().includes(q)));
  }, [roles, search, showSystem]);
  const users = visibleRoles.filter((r) => !r.isRole);
  const groups = visibleRoles.filter((r) => r.isRole);
  const roleChoices = useMemo(
    () =>
      (roles ?? [])
        .filter((r) => (pg ? !r.system || /^pg_(read|write)_all_data$|^pg_monitor$/.test(r.name) : r.isRole) && (!draft || accountKey(r.name, r.host) !== accountKey(draft.name, draft.host)))
        // rôles de groupe d'abord, puis rôles prédéfinis, puis utilisateurs
        .sort((a, b) => Number(b.isRole && !b.system) - Number(a.isRole && !a.system) || Number(b.system) - Number(a.system) || a.name.localeCompare(b.name)),
    [roles, draft?.name, draft?.host, pg],
  );

  // ---------- droits ----------
  const schemas = useMemo(() => objects.filter((o) => o.type === 'schema').map((o) => o.name), [objects]);
  useEffect(() => {
    if (pg && schemas.length && !schemas.includes(scopeSchema)) setScopeSchema(schemas.includes('public') ? 'public' : schemas[0]);
  }, [schemas]);

  const sections: Section[] = useMemo(() => {
    const f = filter.toLowerCase();
    const match = (o: PrivObject) => !f || o.name.toLowerCase().includes(f);
    const cols = (types: PrivObjectType[]) => {
      const out: string[] = [];
      for (const t of types) for (const p of privilegeSet(kind, t)) if (!out.includes(p)) out.push(p);
      return out;
    };
    const withExtras = (rows: PrivObject[], base: string[]) => {
      const out = [...base];
      for (const r of rows) for (const p of r.privileges) if (!out.includes(p)) out.push(p);
      return out;
    };
    if (pg) {
      const dbRows = objects.filter((o) => o.type === 'database');
      const schRows = objects.filter((o) => o.type === 'schema');
      const inSchema = objects.filter((o) => o.schema === scopeSchema && match(o));
      const rel = inSchema.filter((o) => o.type === 'table' || o.type === 'view');
      const seq = inSchema.filter((o) => o.type === 'sequence');
      const fn = inSchema.filter((o) => o.type === 'function' || o.type === 'procedure');
      return [
        { id: 'db', title: 'Bases de données', rows: dbRows, columns: withExtras(dbRows, cols(['database'])) },
        { id: 'schema', title: 'Schémas', rows: schRows, columns: withExtras(schRows, cols(['schema'])) },
        { id: 'rel', title: `Tables et vues · ${scopeSchema}`, rows: rel, columns: withExtras(rel, cols(['table'])), schema: scopeSchema },
        { id: 'seq', title: `Séquences · ${scopeSchema}`, rows: seq, columns: withExtras(seq, cols(['sequence'])), schema: scopeSchema },
        { id: 'fn', title: `Fonctions et procédures · ${scopeSchema}`, rows: fn, columns: ['EXECUTE'], schema: scopeSchema },
      ].filter((s) => s.rows.length || s.id === 'rel');
    }
    const global = objects.filter((o) => o.type === 'global');
    const dbRows = objects.filter((o) => o.type === 'database' && match(o));
    const inDb = objects.filter((o) => o.database && match(o));
    const rel = inDb.filter((o) => o.type === 'table' || o.type === 'view');
    const fn = inDb.filter((o) => o.type === 'function' || o.type === 'procedure');
    return [
      { id: 'global', title: 'Serveur (*.*)', hint: 'Droits sur toutes les bases', rows: global, columns: withExtras(global, cols(['global'])), chips: true },
      { id: 'db', title: 'Bases de données', rows: dbRows, columns: withExtras(dbRows, cols(['database'])) },
      { id: 'rel', title: tab.database ? `Tables et vues · ${tab.database}` : 'Tables et vues', rows: rel, columns: withExtras(rel, cols(['table'])) },
      { id: 'fn', title: 'Routines', rows: fn, columns: cols(['function']) },
    ].filter((s) => s.rows.length || s.id === 'db');
  }, [objects, pg, scopeSchema, filter, kind, tab.database]);

  const original = useMemo(() => new Map((detail?.objects ?? []).map((o) => [o.key, o])), [detail]);

  const setPrivs = (keys: Set<string>, fn: (o: PrivObject) => string[]) =>
    setObjects((list) => list.map((o) => (keys.has(o.key) && !o.isOwner ? { ...o, privileges: fn(o) } : o)));

  const toggleCell = (o: PrivObject, p: string) =>
    setPrivs(new Set([o.key]), (x) => (x.privileges.includes(p) ? x.privileges.filter((y) => y !== p) : [...x.privileges, p]));

  const toggleColumn = (s: Section, p: string) => {
    const rows = s.rows.filter((o) => !o.isOwner && privilegeSet(kind, o.type).includes(p));
    const allOn = rows.every((o) => o.privileges.includes(p));
    setPrivs(new Set(rows.map((o) => o.key)), (x) => (allOn ? x.privileges.filter((y) => y !== p) : [...new Set([...x.privileges, p])]));
  };

  const toggleRow = (o: PrivObject) => {
    const all = privilegeSet(kind, o.type);
    const full = all.every((p) => o.privileges.includes(p));
    setPrivs(new Set([o.key]), () => (full ? [] : all));
  };

  /** Les modèles ne visent que la base / le schéma courants dans les sections « Bases » et « Schémas » */
  const presetRows = (s: Section) => (s.id === 'db' ? s.rows.filter((o) => o.name === tab.database) : s.id === 'schema' ? s.rows.filter((o) => o.name === scopeSchema) : s.rows);

  const applyPreset = (s: Section, preset: Preset['id'], withDefaults: boolean) => {
    setPrivs(new Set(presetRows(s).map((o) => o.key)), (o) => presetPrivileges(kind, preset, o.type));
    if (pg && s.schema && draft) {
      // accès au schéma et à la base nécessaires pour que les droits sur les objets servent à quelque chose
      if (preset !== 'none') {
        const need = new Set(objects.filter((o) => (o.type === 'schema' && o.name === s.schema) || (o.type === 'database' && o.name === tab.database)).map((o) => o.key));
        setObjects((list) =>
          list.map((o) => {
            if (!need.has(o.key) || o.isOwner) return o;
            const add = o.type === 'schema' ? ['USAGE'] : ['CONNECT'];
            return { ...o, privileges: [...new Set([...o.privileges, ...add])] };
          }),
        );
      }
      if (withDefaults) setExtra(defaultPrivilegesScript(s.schema, draft.name, preset));
    }
  };

  // ---------- rendu ----------
  const set = (p: Partial<RoleDraft>) => setDraft((d) => (d ? { ...d, ...p } : d));
  const roleKey = draft ? accountKey(draft.name, draft.host) : '';
  const isSelf = !!detail && detail.role.name === currentUser;

  const roleItem = (r: RoleInfo) => {
    const k = accountKey(r.name, r.host);
    return (
      <div key={k} className={`usr-item ${selected === k ? 'current' : ''}`} onClick={() => (setSelected(k), setSub(sub === 'sql' ? 'general' : sub))} title={k}>
        <RoleIcon r={r} />
        <span className="nm">{r.name}</span>
        {!pg && r.host && <span className="hint sm">@{r.host}</span>}
        <span style={{ flex: 1 }} />
        {r.superuser && <span className="usr-badge super">super</span>}
        {r.locked && <Lock className="usr-ico lock" aria-label="verrouillé" />}
        {pg && !r.isRole && r.validUntil && new Date(r.validUntil) < new Date() && <span className="usr-badge warn">expiré</span>}
        {r.name === currentUser && <span className="usr-badge me">toi</span>}
      </div>
    );
  };

  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="toolbar cmp-bar">
        <Shield style={{ width: 16, height: 16, color: 'var(--accent)' }} />
        <b style={{ fontSize: 13 }}>{conn?.name ?? '?'}</b>
        <span className="cmp-label" style={{ marginLeft: 10 }}>
          {pg ? 'Base (droits)' : 'Base (objets)'}
        </span>
        <select className="input small" value={tab.database} onChange={(e) => updateTab(tab.id, { database: e.target.value } as Partial<Tab>)} aria-label="Base">
          {!pg && <option value="">—</option>}
          {!dbs.includes(tab.database) && tab.database && <option>{tab.database}</option>}
          {dbs.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => startNew(false)}>
          <Plus /> Utilisateur
        </button>
        <button className="btn" onClick={() => startNew(true)}>
          <Plus /> Rôle
        </button>
        <button className="btn icon" title="Actualiser" onClick={() => loadList().then(() => { if (selected) loadDetail(selected); })}>
          <RefreshCw />
        </button>
      </div>
      {listError && <div className="banner err">{listError}</div>}

      <div className="usr-body">
        <div className="usr-list">
          <div className="usr-search">
            <Search />
            <input className="input small" placeholder="Rechercher…" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {roles === null && !listError && (
            <div className="empty-state">
              <Loader2 className="spin" />
            </div>
          )}
          {roles && (
            <>
              <div className="usr-group">
                Utilisateurs <span className="hint">({users.length})</span>
              </div>
              {users.map(roleItem)}
              <div className="usr-group">
                Rôles <span className="hint">({groups.length})</span>
              </div>
              {groups.map(roleItem)}
              {!groups.length && <div className="hint usr-empty">Aucun rôle. Un rôle regroupe des droits que l’on accorde ensuite à plusieurs utilisateurs.</div>}
              <label className="check usr-sys">
                <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} /> Comptes système
              </label>
            </>
          )}
        </div>

        <div className="usr-main">
          {!draft ? (
            <div className="empty-state">
              <div className="inner">
                {loading ? (
                  <Loader2 className="spin" />
                ) : (
                  <>
                    Sélectionne un compte, ou crée un <b>utilisateur</b> (il se connecte) ou un <b>rôle</b> (un groupe de droits à attribuer).
                    <br />
                    <br />
                    Bon réflexe : un compte par application, avec seulement les droits dont elle a besoin.
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="usr-head">
                <RoleIcon r={draft} />
                <h2>{draft.name || (draft.isRole ? 'Nouveau rôle' : 'Nouvel utilisateur')}</h2>
                {!pg && draft.host && <span className="hint">@{draft.host}</span>}
                {isNew && <span className="usr-badge new">nouveau</span>}
                <span style={{ flex: 1 }} />
                <div className="seg">
                  {(
                    [
                      ['general', 'Général'],
                      ['privs', 'Droits'],
                      ['sql', `SQL${script.length ? ` (${script.length})` : ''}`],
                    ] as [Sub, string][]
                  ).map(([id, l]) => (
                    <button key={id} className={sub === id ? 'active' : ''} onClick={() => setSub(id)}>
                      {l}
                    </button>
                  ))}
                </div>
              </div>
              {error && <div className="banner err" style={{ whiteSpace: 'pre-wrap' }}>{error}</div>}
              {loading && <div className="progress indeterminate"><div /></div>}

              <div className="usr-content">
                {sub === 'general' && (
                  <div className="page" style={{ maxWidth: 820, padding: '16px 20px' }}>
                    <div className="form-grid">
                      <Field label="Nom">
                        <input className="input mono" value={draft.name} autoFocus={isNew} onChange={(e) => set({ name: e.target.value })} placeholder={draft.isRole ? 'lecteurs' : 'app_boutique'} />
                      </Field>
                      {!pg && (
                        <Field label="Hôte autorisé" hint="% = toutes les machines ; localhost = ce serveur ; 10.0.0.% = un réseau">
                          <input className="input mono" value={draft.host} disabled={draft.isRole && flavor === 'mariadb'} onChange={(e) => set({ host: e.target.value })} />
                        </Field>
                      )}
                      {pg && (
                        <Field label="Type">
                          <div className="seg">
                            <button className={draft.canLogin ? 'active' : ''} onClick={() => set({ canLogin: true, isRole: false })}>
                              Utilisateur (connexion)
                            </button>
                            <button className={!draft.canLogin ? 'active' : ''} onClick={() => set({ canLogin: false, isRole: true })}>
                              Rôle (groupe)
                            </button>
                          </div>
                        </Field>
                      )}

                      {!(kind === 'mysql' && draft.isRole) && (
                        <Field
                          label={isNew ? 'Mot de passe' : 'Nouveau mot de passe'}
                          className="full"
                          hint={
                            isNew
                              ? 'Généré automatiquement : copie-le avant d’appliquer, il ne sera plus affiché.'
                              : `Laisser vide pour ne pas le changer.${detail?.role.hasPassword === false ? ' Ce compte n’a pas de mot de passe.' : ''}`
                          }
                        >
                          <div className="form-row">
                            <input
                              className="input mono"
                              style={{ flex: 1 }}
                              type={showPw ? 'text' : 'password'}
                              value={draft.password ?? ''}
                              autoComplete="new-password"
                              onChange={(e) => set({ password: e.target.value, clearPassword: false })}
                            />
                            <button className="btn icon" title={showPw ? 'Masquer' : 'Afficher'} onClick={() => setShowPw(!showPw)}>
                              {showPw ? <EyeOff /> : <Eye />}
                            </button>
                            <button className="btn outline" onClick={() => (set({ password: generatePassword(), clearPassword: false }), setShowPw(true))}>
                              <KeyRound /> Générer
                            </button>
                            <button className="btn icon" title="Copier" disabled={!draft.password} onClick={() => navigator.clipboard.writeText(draft.password ?? '').then(() => toast('Mot de passe copié'))}>
                              <Copy />
                            </button>
                          </div>
                          {pg && !isNew && detail?.role.hasPassword && (
                            <label className="check" style={{ marginTop: 6 }}>
                              <input type="checkbox" checked={!!draft.clearPassword} onChange={(e) => set({ clearPassword: e.target.checked, password: '' })} /> Supprimer le mot de passe
                            </label>
                          )}
                        </Field>
                      )}

                      {pg ? (
                        <>
                          <Field label="Expiration du mot de passe" hint="Vide = jamais">
                            <input className="input" type="date" value={draft.validUntil?.slice(0, 10) ?? ''} onChange={(e) => set({ validUntil: e.target.value || null })} />
                          </Field>
                          <Field label="Connexions simultanées" hint="-1 = illimité">
                            <input className="input" type="number" min={-1} value={draft.connLimit} onChange={(e) => set({ connLimit: Number(e.target.value) })} style={{ width: 120 }} />
                          </Field>
                          <Field label="Attributs" className="full">
                            <div className="usr-attrs">
                              {(
                                [
                                  ['superuser', 'Superutilisateur', 'Tous les droits, sans aucune vérification'],
                                  ['createDb', 'Créer des bases', ''],
                                  ['createRole', 'Créer des rôles', 'Peut créer, modifier et supprimer d’autres rôles'],
                                  ['inherit', 'Hérite des droits de ses rôles', ''],
                                  ['replication', 'Réplication', 'Connexions de réplication et sauvegardes physiques'],
                                  ['bypassRls', 'Ignore la sécurité par ligne (RLS)', ''],
                                ] as [keyof RoleDraft, string, string][]
                              ).map(([k, l, h]) => (
                                <label key={k} className="check" title={h}>
                                  <input type="checkbox" checked={!!draft[k]} onChange={(e) => set({ [k]: e.target.checked } as Partial<RoleDraft>)} /> {l}
                                </label>
                              ))}
                            </div>
                          </Field>
                          <Field label="Commentaire" className="full">
                            <input className="input" value={draft.comment ?? ''} onChange={(e) => set({ comment: e.target.value || null })} />
                          </Field>
                        </>
                      ) : (
                        !draft.isRole && (
                          <>
                            <Field label="Connexions simultanées" hint="0 = illimité">
                              <input className="input" type="number" min={0} value={draft.connLimit} onChange={(e) => set({ connLimit: Number(e.target.value) })} style={{ width: 120 }} />
                            </Field>
                            <Field label="Compte">
                              <label className="check">
                                <input type="checkbox" checked={draft.locked} onChange={(e) => set({ locked: e.target.checked })} /> Verrouillé (connexion refusée)
                              </label>
                            </Field>
                          </>
                        )
                      )}

                      <Field label={pg ? 'Membre des rôles' : 'Rôles attribués'} className="full" hint={!pg && flavor === 'mariadb' ? 'MariaDB : seul le premier rôle est activé automatiquement à la connexion.' : undefined}>
                        <div className="usr-chips">
                          {roleChoices.length === 0 && <span className="hint">Aucun rôle disponible : crée d’abord un rôle.</span>}
                          {roleChoices.map((r) => {
                            const k = accountKey(r.name, r.host);
                            const on = draft.memberOf.includes(k);
                            return (
                              <button key={k} className={`usr-chip ${on ? 'on' : ''}`} onClick={() => set({ memberOf: on ? draft.memberOf.filter((x) => x !== k) : [...draft.memberOf, k] })}>
                                {on ? <Check /> : <Plus />} {k}
                              </button>
                            );
                          })}
                        </div>
                      </Field>
                      {detail && detail.members.length > 0 && (
                        <Field label="Membres de ce rôle" className="full">
                          <div className="usr-chips">
                            {detail.members.map((m) => (
                              <span key={m} className="usr-chip static">
                                <User /> {m}
                              </span>
                            ))}
                          </div>
                        </Field>
                      )}
                    </div>
                  </div>
                )}

                {sub === 'privs' && (
                  <div className="usr-privs">
                    {isNew ? (
                      <div className="banner info">Crée d’abord le compte (bouton « Appliquer »), puis attribue ses droits ici.</div>
                    ) : (
                      <>
                        <div className="usr-privbar">
                          {pg && (
                            <>
                              <span className="cmp-label">Schéma</span>
                              <select className="input small" value={scopeSchema} onChange={(e) => setScopeSchema(e.target.value)}>
                                {schemas.map((s) => (
                                  <option key={s}>{s}</option>
                                ))}
                              </select>
                            </>
                          )}
                          <input className="input small" placeholder="Filtrer les objets…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: 200 }} />
                          <span style={{ flex: 1 }} />
                          {draft.superuser && <span className="usr-badge super">superutilisateur : tous les droits, quelle que soit la grille</span>}
                          {draft.memberOf.length > 0 && <span className="hint">Hérite aussi de : {draft.memberOf.join(', ')}</span>}
                        </div>
                        {sections.map((s) => (
                          <PrivSection
                            key={s.id}
                            kind={kind}
                            s={s}
                            original={original}
                            onCell={toggleCell}
                            onColumn={(p) => toggleColumn(s, p)}
                            onRow={toggleRow}
                            onPreset={(p, d) => applyPreset(s, p, d)}
                            canDefaults={pg && !!s.schema && s.id === 'rel'}
                            presetTarget={s.id === 'db' ? tab.database : s.id === 'schema' ? scopeSchema : undefined}
                            presetCount={presetRows(s).length}
                          />
                        ))}
                        {extra.length > 0 && (
                          <div className="banner info" style={{ borderRadius: 6, margin: '8px 16px' }}>
                            Droits par défaut ajoutés au script : ils s’appliqueront aux objets créés plus tard dans « {scopeSchema} » par {currentUser}.
                            <button className="btn small outline" style={{ marginLeft: 8 }} onClick={() => setExtra([])}>
                              Retirer
                            </button>
                          </div>
                        )}
                        {detail && detail.other.length > 0 && (
                          <div className="usr-other">
                            <div className="hint">Autres droits, non modifiables ici (colonnes, motifs, PROXY) :</div>
                            <pre className="sql-preview">{detail.other.join('\n')}</pre>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {sub === 'sql' && (
                  <div style={{ padding: 16 }}>
                    {script.length ? (
                      <>
                        <pre className="sql-preview" style={{ maxHeight: 'none' }}>
                          {script.join('\n')}
                        </pre>
                        <div className="form-row" style={{ marginTop: 10 }}>
                          <button className="btn outline" onClick={() => navigator.clipboard.writeText(script.join('\n')).then(() => toast('Script copié (mots de passe masqués)'))}>
                            <Copy /> Copier
                          </button>
                          <button className="btn outline" onClick={() => newQueryTab(tab.connectionId, tab.database, script.join('\n'), `Comptes ${draft.name}`)}>
                            Ouvrir dans l’éditeur
                          </button>
                          <span className="hint">Les mots de passe sont masqués dans l’aperçu ; ils sont envoyés en clair au serveur à l’application.</span>
                        </div>
                      </>
                    ) : (
                      <div className="empty-state">Aucune modification.</div>
                    )}
                  </div>
                )}
              </div>

              <div className="result-footer">
                {detail && (
                  <button className="btn outline danger" disabled={isSelf || busy} title={isSelf ? 'Compte utilisé par cette connexion' : ''} onClick={() => setDropOpen(true)}>
                    <Trash2 /> Supprimer…
                  </button>
                )}
                <span style={{ flex: 1 }} />
                {dirty && <span className="hint">{script.length} modification(s) en attente</span>}
                <button className="btn" disabled={!dirty && !isNew} onClick={reset}>
                  <RotateCcw /> {isNew ? 'Annuler' : 'Annuler les modifications'}
                </button>
                <button className="btn primary" disabled={!dirty || busy || !draft.name.trim()} onClick={apply}>
                  {busy ? <Loader2 className="spin" /> : <Play />} {isNew ? 'Créer' : 'Appliquer'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {dropOpen && detail && (
        <DropDialog
          kind={kind}
          role={detail.role}
          db={tab.database}
          others={(roles ?? []).filter((r) => accountKey(r.name, r.host) !== roleKey && !r.system).map((r) => r.name)}
          currentUser={currentUser}
          onClose={() => setDropOpen(false)}
          onDrop={async (stmts) => {
            const r = await api.rolesApply(tab.connectionId, tab.database, stmts);
            if (r.error) throw new Error(r.error);
            toast(`Compte ${detail.role.name} supprimé`, 'success');
            setDropOpen(false);
            setSelected(null);
            setDetail(null);
            setDraft(null);
            await loadList();
          }}
        />
      )}
    </div>
  );
}

function PrivSection(props: {
  kind: DbKind;
  s: Section;
  original: Map<string, PrivObject>;
  onCell: (o: PrivObject, p: string) => void;
  onColumn: (p: string) => void;
  onRow: (o: PrivObject) => void;
  onPreset: (p: Preset['id'], withDefaults: boolean) => void;
  canDefaults: boolean;
  /** nom de la seule ligne visée par les modèles (bases, schémas) */
  presetTarget?: string;
  presetCount: number;
}) {
  const { kind, s, original } = props;
  const [defaults, setDefaults] = useState(false);
  const changed = (o: PrivObject, p: string) => {
    const before = original.get(o.key)?.privileges ?? [];
    return before.includes(p) !== o.privileges.includes(p);
  };
  const rowChanged = (o: PrivObject) => !sameSet(original.get(o.key)?.privileges ?? [], o.privileges);
  return (
    <div className="usr-sec">
      <div className="usr-sec-head">
        <h4>
          {s.title} <span className="hint">({s.rows.length})</span>
        </h4>
        {s.hint && <span className="hint">{s.hint}</span>}
        <span style={{ flex: 1 }} />
        {s.id !== 'global' && props.presetCount > 0 && (
          <>
            <Wand2 className="usr-ico" />
            {props.presetTarget && <span className="hint">« {props.presetTarget} » :</span>}
            {PRESETS.map((p) => (
              <button key={p.id} className="btn small outline" onClick={() => props.onPreset(p.id, defaults)}>
                {p.label}
              </button>
            ))}
            {props.canDefaults && (
              <label className="check" title="ALTER DEFAULT PRIVILEGES : les tables, séquences et fonctions créées plus tard dans ce schéma recevront les mêmes droits">
                <input type="checkbox" checked={defaults} onChange={(e) => setDefaults(e.target.checked)} /> + objets futurs
              </label>
            )}
          </>
        )}
      </div>
      {!s.rows.length ? (
        <div className="hint" style={{ padding: '4px 16px 10px' }}>
          Aucun objet.
        </div>
      ) : s.chips ? (
        s.rows.map((o) => (
          <div key={o.key} className="usr-chiprow">
            {s.columns.map((p) => (
              <button key={p} className={`usr-chip ${o.privileges.includes(p) ? 'on' : ''} ${changed(o, p) ? 'changed' : ''}`} onClick={() => props.onCell(o, p)}>
                {p}
                {o.grantable.includes(p) && <sup title="avec GRANT OPTION">G</sup>}
              </button>
            ))}
          </div>
        ))
      ) : (
        <div className="usr-grid-wrap">
          <table className="usr-grid">
            <thead>
              <tr>
                <th className="obj">Objet</th>
                {s.columns.map((p) => (
                  <th key={p} title={`${p} : cliquer pour tout cocher / décocher`} onClick={() => props.onColumn(p)}>
                    {PRIV_SHORT[p] ?? p}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.rows.map((o) => {
                const avail = privilegeSet(kind, o.type);
                return (
                  <tr key={o.key} className={rowChanged(o) ? 'changed' : ''}>
                    <td className="obj" onClick={() => props.onRow(o)} title={o.isOwner ? 'Propriétaire : tous les droits' : 'Cliquer pour tout cocher / décocher'}>
                      <span className="usr-type">{TYPE_LABEL[o.type]}</span>
                      <span className="mono">{o.name}</span>
                      {o.args !== undefined && <span className="hint sm">({o.args})</span>}
                      {o.isOwner && <span className="usr-badge me">propriétaire</span>}
                    </td>
                    {s.columns.map((p) => {
                      const ok = avail.includes(p) || o.privileges.includes(p);
                      return (
                        <td key={p} className={`cell ${changed(o, p) ? 'changed' : ''}`}>
                          {ok && (
                            <input
                              type="checkbox"
                              checked={o.isOwner || o.privileges.includes(p)}
                              disabled={o.isOwner}
                              onChange={() => props.onCell(o, p)}
                              aria-label={`${p} sur ${o.name}`}
                            />
                          )}
                          {o.grantable.includes(p) && <sup title="avec GRANT OPTION">G</sup>}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DropDialog(props: {
  kind: DbKind;
  role: RoleInfo;
  db: string;
  others: string[];
  currentUser: string;
  onClose: () => void;
  onDrop: (stmts: string[]) => Promise<void>;
}) {
  const { kind, role } = props;
  const [mode, setMode] = useState<'reassign' | 'drop' | 'none'>('reassign');
  const [to, setTo] = useState(props.currentUser);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stmts =
    kind === 'postgres'
      ? dropRoleScript(kind, role, mode === 'reassign' ? { reassignTo: to } : mode === 'drop' ? { dropOwned: true } : {})
      : dropRoleScript(kind, role);
  return (
    <Modal
      title={`Supprimer ${role.isRole ? 'le rôle' : 'l’utilisateur'} ${accountKey(role.name, role.host)}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn outline" onClick={props.onClose}>
            Annuler
          </button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await props.onDrop(stmts);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <Loader2 className="spin" /> : <Trash2 />} Supprimer
          </button>
        </>
      }
    >
      {kind === 'postgres' && (
        <>
          <p>Un rôle qui possède des objets ou des droits ne peut pas être supprimé directement. Que faire de ce qu’il possède dans la base « {props.db} » ?</p>
          <label className="check" style={{ display: 'flex', margin: '6px 0' }}>
            <input type="radio" checked={mode === 'reassign'} onChange={() => setMode('reassign')} /> Donner ses objets à
            <select className="input small" value={to} onChange={(e) => setTo(e.target.value)} disabled={mode !== 'reassign'}>
              {props.others.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </select>
            puis retirer ses droits
          </label>
          <label className="check" style={{ display: 'flex', margin: '6px 0' }}>
            <input type="radio" checked={mode === 'drop'} onChange={() => setMode('drop')} /> Supprimer ses objets et ses droits
          </label>
          <label className="check" style={{ display: 'flex', margin: '6px 0' }}>
            <input type="radio" checked={mode === 'none'} onChange={() => setMode('none')} /> Rien (échoue s’il possède quelque chose)
          </label>
          <div className="banner warn" style={{ borderRadius: 6, margin: '10px 0' }}>
            <AlertTriangle /> REASSIGN / DROP OWNED ne concernent que la base « {props.db} ». Si le rôle possède des objets dans d’autres bases, recommence depuis chacune d’elles.
          </div>
        </>
      )}
      <pre className="sql-preview">{stmts.join('\n')}</pre>
      {error && <div className="banner err" style={{ borderRadius: 6, marginTop: 10, whiteSpace: 'pre-wrap' }}>{error}</div>}
    </Modal>
  );
}
