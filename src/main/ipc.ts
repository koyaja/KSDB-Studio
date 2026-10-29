// Points d'entrée IPC exposés à l'interface.
import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { splitSql } from '../shared/sqlsplit';
import type {
  ApiResult,
  CellValue,
  ConnectionConfig,
  DumpOptions,
  ExportFormat,
  ExportTableOptions,
  ImportCsvOptions,
  JobEvent,
  ObjectType,
  RestoreOptions,
  ResultField,
  RowChange,
  Settings,
  GroupSettings,
  AppInfo,
  UpdateInfo,
  TransferOptions,
  VpnProfile,
} from '../shared/types';
import { ConnectionManager } from './connections';
import { makeWriter, previewCsv, readCsvBatches } from './csv';
import { friendlyError, PageOptions } from './drivers/base';
import { encryptNavicat, parseNcx } from './navicat';
import { dataDir, Store } from './store';
import { checkForUpdate, download, installKind, RELEASES_URL } from './update';
import { applyRoleScript, listRoles, roleDetail } from './roles';
import { redactSecrets } from '../shared/roles';
import { parseWgConfig, suggestTunnelName, TUNNEL_NAME_RE, VpnManager } from './vpn';
import { dump, Job, restore, toolStatus } from './tools';
import { runTransfer } from './transfer';

export function registerIpc(store: Store, getWindow: () => BrowserWindow | null) {
  const emitVpn = (payload: unknown) => getWindow()?.webContents.send('vpn:event', payload);
  const vpn = new VpnManager({ dataDir: dataDir(), readConfig: (id) => store.vpnConfig(id) });
  const vpnLocks = new Map<string, Promise<unknown>>();

  /** Démarre (une seule fois à la fois) le VPN associé à une connexion. */
  const ensureVpn = async (cfg: { vpnId?: string; group?: string; name?: string }) => {
    const vpnId = store.effectiveVpnId(cfg);
    if (!vpnId) return;
    const profile = store.vpnProfile(vpnId);
    if (!profile) return;
    const st = await vpn.status(profile);
    if (st.state === 'up') return;
    if (!profile.autoStart)
      throw new Error(`Le VPN « ${profile.name} » requis par cette connexion n’est pas actif. Démarre-le depuis le menu VPN.`);
    let pending = vpnLocks.get(vpnId);
    if (!pending) {
      emitVpn({ id: vpnId, state: 'starting' });
      pending = vpn
        .start(profile)
        .then((s) => emitVpn(s))
        .catch((e) => {
          emitVpn({ id: vpnId, state: 'down', detail: friendlyError(e) });
          throw new Error(`VPN « ${profile.name} » : ${friendlyError(e)}`);
        })
        .finally(() => vpnLocks.delete(vpnId));
      vpnLocks.set(vpnId, pending);
    }
    await pending;
  };

  const cm = new ConnectionManager((id) => store.get(id), ensureVpn);
  const jobs = new Map<string, Job>();

  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R> | R) => {
    ipcMain.handle(channel, async (_e, ...args: unknown[]): Promise<ApiResult<R>> => {
      try {
        return { ok: true, data: await fn(...(args as A)) };
      } catch (e) {
        return { ok: false, error: friendlyError(e) };
      }
    });
  };

  const emit = (ev: JobEvent) => getWindow()?.webContents.send('job:event', ev);

  const startJob = (work: (job: Job, jobId: string) => Promise<string | void>): string => {
    const jobId = crypto.randomUUID();
    const job: Job = { child: null, cancelled: false };
    jobs.set(jobId, job);
    work(job, jobId)
      .then((msg) => emit({ jobId, kind: 'done', message: msg || 'Terminé' }))
      .catch((e) => emit({ jobId, kind: 'error', message: friendlyError(e) }))
      .finally(() => jobs.delete(jobId));
    return jobId;
  };

  // ---------- Application ----------
  handle('app:settings', () => store.settings());
  handle('app:saveSettings', (s: Settings) => store.saveSettings(s));
  handle('app:tools', () => toolStatus(store.settings()));
  handle('app:workspace', () => store.workspace());
  handle('app:saveWorkspace', (w: unknown) => store.saveWorkspace(w));
  handle('app:openDialog', async (opts: Electron.OpenDialogOptions) => {
    const r = await dialog.showOpenDialog(getWindow()!, opts);
    return r.canceled ? null : r.filePaths;
  });
  handle('app:saveDialog', async (opts: Electron.SaveDialogOptions) => {
    const r = await dialog.showSaveDialog(getWindow()!, opts);
    return r.canceled ? null : r.filePath ?? null;
  });
  handle('app:readText', (p: string) => fs.promises.readFile(p, 'utf8'));
  handle('app:writeBase64', (p: string, b64: string) => fs.promises.writeFile(p, Buffer.from(b64, 'base64')));
  handle('app:writeText', (p: string, content: string) => fs.promises.writeFile(p, content, 'utf8'));
  handle('app:openExternal', (url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));
  handle('app:showItem', (p: string) => shell.showItemInFolder(p));

  // ---------- Connexions ----------
  handle('conn:list', () =>
    store.list().map((c) => ({ ...c, connected: cm.isConnected(c.id), effectiveVpnId: store.effectiveVpnId(c) ?? null })),
  );

  // ---------- Groupes ----------
  handle('group:list', () => store.groups());
  handle('group:set', (name: string, g: GroupSettings) => store.setGroup(name, g));
  handle('group:rename', (from: string, to: string) => store.renameGroup(from, to));

  // ---------- VPN WireGuard ----------
  handle('vpn:backend', () => vpn.backend(true));
  handle('vpn:list', async () => {
    const profiles = store.vpnProfiles();
    const statuses = await Promise.all(profiles.map((p) => vpn.status(p)));
    return profiles.map((p, i) => ({ profile: p, status: statuses[i] }));
  });
  handle('vpn:suggestName', (label: string) => suggestTunnelName(label));
  handle('vpn:inspect', (configPath: string) => {
    const text = fs.readFileSync(configPath, 'utf8');
    const r = parseWgConfig(text);
    if (!r.ok) throw new Error(`Fichier WireGuard invalide : ${r.error}`);
    return { endpoint: r.endpoint ?? null, suggestedName: suggestTunnelName(path.basename(configPath).replace(/\.conf(\.dpapi)?$/i, '')) };
  });
  handle('vpn:save', async (p: VpnProfile, source?: { configPath?: string; configText?: string }) => {
    if (!p.name.trim()) throw new Error('Donne un nom au profil VPN.');
    const macApp = process.platform === 'darwin' && p.mode === 'existing' && p.tunnelName.trim().length > 0 && !/["\n]/.test(p.tunnelName);
    if (!macApp && !TUNNEL_NAME_RE.test(p.tunnelName))
      throw new Error('Nom du tunnel invalide : 15 caractères max, lettres, chiffres et _ = + . - uniquement.');
    let config: string | undefined;
    if (source?.configPath) config = fs.readFileSync(source.configPath, 'utf8');
    else if (source?.configText) config = source.configText;
    if (config !== undefined) {
      const r = parseWgConfig(config);
      if (!r.ok) throw new Error(`Configuration WireGuard invalide : ${r.error}`);
      p = { ...p, endpoint: r.endpoint };
    }
    if (p.mode === 'file' && config === undefined && !(p.id && store.vpnConfig(p.id)))
      throw new Error('Importe le fichier .conf WireGuard (ou colle son contenu).');
    const prev = p.id ? store.vpnProfile(p.id) : undefined;
    if (prev && (config !== undefined || prev.tunnelName !== p.tunnelName)) await vpn.invalidate(p, prev.tunnelName).catch(() => {});
    return store.saveVpn(p, config).id;
  });
  handle('vpn:delete', async (id: string) => {
    const p = store.vpnProfile(id);
    if (p) {
      if (vpn.isOwned(id)) await vpn.stop(p).catch(() => {});
      await vpn.invalidate(p).catch(() => {});
    }
    store.removeVpn(id);
  });
  handle('vpn:start', async (id: string) => {
    const p = store.vpnProfile(id);
    if (!p) throw new Error('Profil VPN introuvable');
    emitVpn({ id, state: 'starting' });
    try {
      const st = await vpn.start(p);
      emitVpn(st);
      return st;
    } catch (e) {
      emitVpn({ id, state: 'down', detail: friendlyError(e) });
      throw e;
    }
  });
  handle('vpn:stop', async (id: string) => {
    const p = store.vpnProfile(id);
    if (!p) throw new Error('Profil VPN introuvable');
    // fermer d'abord les connexions qui passent par ce VPN
    for (const cid of cm.connectedIds()) {
      const c = store.get(cid);
      if (c && store.effectiveVpnId(c) === id) await cm.disconnect(cid);
    }
    emitVpn({ id, state: 'stopping' });
    const st = await vpn.stop(p).catch((e) => {
      emitVpn({ id, state: 'up', detail: friendlyError(e) });
      throw e;
    });
    emitVpn(st);
    return st;
  });
  handle('conn:save', async (cfg: ConnectionConfig) => {
    const saved = store.save(cfg);
    await cm.disconnect(saved.id);
    return saved.id;
  });
  handle('conn:delete', async (id: string) => {
    await cm.disconnect(id);
    store.remove(id);
  });
  handle('conn:reorder', (ids: string[]) => store.reorder(ids));
  handle('conn:test', async (cfg: ConnectionConfig) => {
    // champs secrets non modifiés : on reprend ceux enregistrés
    const prev = cfg.id ? store.get(cfg.id) : undefined;
    const full: ConnectionConfig = {
      ...cfg,
      password: cfg.password ?? prev?.password,
      ssh: { ...cfg.ssh, password: cfg.ssh.password ?? prev?.ssh.password, passphrase: cfg.ssh.passphrase ?? prev?.ssh.passphrase },
    };
    await ensureVpn(full);
    return ConnectionManager.test(full);
  });
  handle('conn:connect', async (id: string, password?: string) => {
    if (password !== undefined) cm.setRuntimePassword(id, password);
    const d = await cm.get(id);
    return d.serverInfo();
  });
  handle('conn:disconnect', (id: string) => cm.disconnect(id));
  handle('conn:importNavicat', (file: string) => {
    const parsed = parseNcx(fs.readFileSync(file, 'utf8'));
    for (const c of parsed.connections) store.save({ ...c, id: '' } as ConnectionConfig);
    return { imported: parsed.connections.length, skipped: parsed.skipped };
  });
  handle('conn:exportFile', (file: string, ids: string[], withPasswords: boolean) => {
    const list = ids.map((id) => store.get(id)).filter(Boolean) as ConnectionConfig[];
    const data = list.map((c) => ({
      ...c,
      password: withPasswords && c.password ? encryptNavicat(c.password) : undefined,
      ssh: {
        ...c.ssh,
        password: withPasswords && c.ssh.password ? encryptNavicat(c.ssh.password) : undefined,
        passphrase: withPasswords && c.ssh.passphrase ? encryptNavicat(c.ssh.passphrase) : undefined,
      },
    }));
    fs.writeFileSync(file, JSON.stringify({ format: 'ksdb-connections', version: 1, connections: data }, null, 2));
    return data.length;
  });
  handle('conn:importFile', async (file: string) => {
    const { decryptNavicat } = await import('./navicat');
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (json.format !== 'ksdb-connections') throw new Error('Fichier non reconnu');
    for (const c of json.connections as ConnectionConfig[]) {
      store.save({
        ...c,
        id: '',
        password: c.password ? decryptNavicat(c.password) : undefined,
        ssh: {
          ...c.ssh,
          password: c.ssh.password ? decryptNavicat(c.ssh.password) : undefined,
          passphrase: c.ssh.passphrase ? decryptNavicat(c.ssh.passphrase) : undefined,
        },
      });
    }
    return json.connections.length as number;
  });

  // ---------- Exploration ----------
  handle('db:serverInfo', async (id: string) => (await cm.get(id)).serverInfo());
  handle('db:databases', async (id: string) => (await cm.get(id)).listDatabases());
  handle('db:schemas', async (id: string, db: string) => (await cm.get(id)).listSchemas(db));
  handle('db:objects', async (id: string, db: string, schema: string) => (await cm.get(id)).listObjects(db, schema));
  handle('db:structure', async (id: string, db: string, schema: string, table: string) =>
    (await cm.get(id)).structure(db, schema, table),
  );
  handle('db:ddl', async (id: string, db: string, schema: string, name: string, type: ObjectType, extra?: string) =>
    (await cm.get(id)).ddl(db, schema, name, type, extra),
  );
  handle('db:snapshot', async (id: string, db: string, schema: string) => (await cm.get(id)).snapshot(db, schema));
  handle('db:erd', async (id: string, db: string, schema: string) => (await cm.get(id)).erdModel(db, schema));
  handle('app:erdLayout', (key: string) => store.erdLayout(key));
  handle('app:saveErdLayout', (key: string, layout: unknown) => store.saveErdLayout(key, layout));
  handle('db:completion', async (id: string, db: string) => (await cm.get(id)).completion(db));

  // ---------- Requêtes ----------
  handle('db:execute', async (id: string, sessionId: string, db: string, sql: string) => {
    const entry = await cm.entry(id);
    const statements = splitSql(sql, entry.driver.kind).map((s) => s.text);
    const t0 = Date.now();
    const results = await entry.driver.execute(sessionId, db, statements, store.settings().maxRows);
    store.addHistory({
      id: crypto.randomUUID(),
      connectionId: id,
      connectionName: entry.cfg.name,
      database: db,
      sql: redactSecrets(sql.length > 20000 ? sql.slice(0, 20000) : sql),
      at: t0,
      durationMs: Date.now() - t0,
      ok: !results.some((r) => r.error),
    });
    return results;
  });
  // ---------- Utilisateurs et droits ----------
  handle('roles:list', async (id: string, db: string) => listRoles(await cm.get(id), db));
  handle('roles:detail', async (id: string, db: string, name: string, host: string) => roleDetail(await cm.get(id), db, name, host));
  handle('roles:apply', async (id: string, db: string, statements: string[]) => {
    const entry = await cm.entry(id);
    if (entry.cfg.readOnly) throw new Error('Connexion en lecture seule : modification des comptes impossible.');
    const t0 = Date.now();
    const r = await applyRoleScript(entry.driver, db, statements);
    store.addHistory({
      id: crypto.randomUUID(),
      connectionId: id,
      connectionName: entry.cfg.name,
      database: db,
      sql: redactSecrets(statements.join('\n')),
      at: t0,
      durationMs: Date.now() - t0,
      ok: !r.error,
    });
    return r;
  });
  handle('db:cancel', async (id: string, sessionId: string) => (await cm.get(id)).cancel(sessionId));
  handle('db:closeSession', async (id: string, sessionId: string) => {
    if (cm.isConnected(id)) await (await cm.get(id)).closeSession(sessionId);
  });
  handle('history:list', () => store.history());
  handle('history:clear', () => store.clearHistory());

  // ---------- Données de table ----------
  handle('db:page', async (id: string, db: string, schema: string, table: string, opts: PageOptions) =>
    (await cm.get(id)).fetchPage(db, schema, table, opts),
  );
  handle('db:count', async (id: string, db: string, schema: string, table: string, where?: string) =>
    (await cm.get(id)).count(db, schema, table, where),
  );
  handle('db:apply', async (id: string, db: string, schema: string, table: string, changes: RowChange[], hiddenKey?: string) =>
    (await cm.get(id)).applyChanges(db, schema, table, changes, hiddenKey),
  );
  handle('db:preview', async (id: string, db: string, schema: string, table: string, changes: RowChange[], hiddenKey?: string) => {
    const d = await cm.get(id);
    return d.previewChanges(d.kind === 'mysql' ? db : schema, table, changes, hiddenKey);
  });
  handle('db:processes', async (id: string) => (await cm.get(id)).processes());
  handle('db:kill', async (id: string, pid: string, mode: 'cancel' | 'terminate') => (await cm.get(id)).kill(pid, mode));

  // ---------- Export ----------
  handle('db:exportRows', async (file: string, format: ExportFormat, fields: ResultField[], rows: CellValue[][], table?: string, bom?: boolean, kind?: 'postgres' | 'mysql') => {
    const q = kind === 'mysql' ? (s: string) => '`' + s.replace(/`/g, '``') + '`' : (s: string) => '"' + s.replace(/"/g, '""') + '"';
    const lit = (v: CellValue) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
    const w = makeWriter(format, { table: table ? q(table) : 'resultat', literal: lit, quoteIdent: q });
    const content = (bom && format === 'csv' ? '﻿' : '') + w.header(fields) + w.rows(rows, fields) + w.footer();
    await fs.promises.writeFile(file, content, 'utf8');
    return rows.length;
  });

  handle('job:exportTable', (o: ExportTableOptions) =>
    startJob(async (_job, jobId) => {
      const d = await cm.get(o.connectionId);
      const qualified = d.kind === 'mysql' ? d.qualified(o.database, o.table) : d.qualified(o.schema, o.table);
      const sql = `SELECT * FROM ${qualified}${o.where?.trim() ? ` WHERE ${o.where}` : ''}`;
      const w = makeWriter(o.format, { table: qualified, literal: (v) => d.literal(v), quoteIdent: (s) => d.quoteIdent(s) });
      const out = fs.createWriteStream(o.filePath, 'utf8');
      const write = (s: string) => new Promise<void>((res, rej) => (s ? out.write(s, (e) => (e ? rej(e) : res())) : res()));
      if (o.csvBom && o.format === 'csv') await write('﻿');
      let n = 0;
      let headerDone = false;
      for await (const b of d.iterate(o.database, sql, 2000)) {
        if (!headerDone) {
          await write(w.header(b.fields));
          headerDone = true;
        }
        await write(w.rows(b.rows, b.fields));
        n += b.rows.length;
        emit({ jobId, kind: 'log', message: `${n.toLocaleString('fr-FR')} lignes exportées…` });
      }
      await write(w.footer());
      await new Promise<void>((r) => out.end(r));
      return `${n.toLocaleString('fr-FR')} lignes exportées vers ${path.basename(o.filePath)}`;
    }),
  );

  // ---------- Import CSV ----------
  handle('csv:preview', (file: string, delimiter: string | undefined, encoding: 'utf8' | 'latin1') =>
    previewCsv(file, delimiter, encoding),
  );
  handle('job:importCsv', (o: ImportCsvOptions) =>
    startJob(async (_job, jobId) => {
      const d = await cm.get(o.connectionId);
      const cols = o.mapping.map((m) => m.column);
      const idx = o.mapping.map((m) => m.csvIndex);
      async function* batches() {
        for await (const rows of readCsvBatches(o.filePath, o.delimiter, o.encoding, o.header, 2000)) {
          yield rows.map((r) => idx.map((i) => {
            const v = r[i];
            return v === undefined || (o.emptyAsNull && v === '') ? null : v;
          }));
        }
      }
      const n = await d.bulkInsert(o.database, o.schema, o.table, cols, batches(), {
        truncate: o.truncate,
        onProgress: (k) => emit({ jobId, kind: 'log', message: `${k.toLocaleString('fr-FR')} lignes insérées…` }),
      });
      return `${n.toLocaleString('fr-FR')} lignes importées dans ${o.table}`;
    }),
  );

  // ---------- Sauvegarde / restauration ----------
  const sinkFor = (jobId: string) => ({
    log: (m: string) => emit({ jobId, kind: 'log', message: m }),
    progress: (p: number) => emit({ jobId, kind: 'progress', progress: p }),
  });
  handle('job:dump', (o: DumpOptions) =>
    startJob(async (job, jobId) => {
      const e = await cm.entry(o.connectionId);
      await dump(job, e.cfg, await e.endpoint(), o, store.settings(), sinkFor(jobId));
      return `Sauvegarde terminée : ${path.basename(o.filePath)}`;
    }),
  );
  handle('job:restore', (o: RestoreOptions) =>
    startJob(async (job, jobId) => {
      const e = await cm.entry(o.connectionId);
      if (o.createDatabase) {
        const exists = (await e.driver.listDatabases()).includes(o.database);
        if (!exists) {
          const sql =
            e.driver.kind === 'postgres'
              ? `CREATE DATABASE ${e.driver.quoteIdent(o.database)}`
              : `CREATE DATABASE ${e.driver.quoteIdent(o.database)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`;
          sinkFor(jobId).log(sql);
          const sid = 'restore-' + jobId;
          const r = await e.driver.execute(sid, '', [sql], 1);
          await e.driver.closeSession(sid);
          if (r[0]?.error) throw new Error(r[0].error);
        }
      }
      await restore(job, e.cfg, await e.endpoint(), o, store.settings(), sinkFor(jobId));
      return `Restauration terminée dans ${o.database}`;
    }),
  );
  handle('job:transfer', (o: TransferOptions) =>
    startJob(async (job, jobId) => {
      const src = await cm.get(o.source.connectionId);
      const tgt = await cm.get(o.target.connectionId);
      const r = await runTransfer(o, {
        src,
        tgt,
        id: jobId,
        cancelled: () => job.cancelled,
        emit: (data) => emit({ jobId, kind: 'data', data }),
      });
      return r.errors
        ? `Transfert terminé avec ${r.errors} erreur(s) : ${r.rows.toLocaleString('fr-FR')} ligne(s) copiée(s)`
        : `Transfert terminé : ${r.rows.toLocaleString('fr-FR')} ligne(s) copiée(s)`;
    }),
  );
  handle('job:cancel', (jobId: string) => {
    const j = jobs.get(jobId);
    if (j) {
      j.cancelled = true;
      j.child?.kill();
    }
  });

  // ---------- Version et mises à jour ----------
  const emitUpdate = (payload: unknown) => getWindow()?.webContents.send('app:update', payload);
  let lastUpdate: UpdateInfo | null = null;
  let downloadAbort: AbortController | null = null;

  handle('app:info', (): AppInfo => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    installKind: installKind(),
    dataDir: dataDir(),
    releasesUrl: RELEASES_URL,
  }));

  /** manual = clic de l'utilisateur : on répond même si la version a été ignorée */
  const runCheck = async (manual: boolean) => {
    const info = await checkForUpdate(app.getVersion());
    lastUpdate = info;
    const s = store.settings();
    if (!manual && info?.available && s.skippedVersion !== info.latest) {
      emitUpdate(info);
      if (!manual && Notification.isSupported()) {
        const n = new Notification({
          title: `KSDB Studio ${info.latest} est disponible`,
          body: `Tu utilises la version ${info.current}. Clique pour voir les nouveautés.`,
        });
        n.on('click', () => {
          const w = getWindow();
          if (w) {
            if (w.isMinimized()) w.restore();
            w.focus();
            emitUpdate({ ...info, open: true });
          }
        });
        n.show();
      }
    }
    return info;
  };

  handle('app:checkUpdate', () => runCheck(true));
  handle('app:lastUpdate', () => lastUpdate);
  handle('app:downloadUpdate', async () => {
    if (!lastUpdate?.asset) throw new Error('Aucun fichier à télécharger pour ce système : ouvre la page de la release.');
    const dest = path.join(app.getPath('downloads'), lastUpdate.asset.name);
    downloadAbort?.abort();
    downloadAbort = new AbortController();
    const file = await download(
      lastUpdate.asset.url,
      dest,
      (done, total) => emitUpdate({ progress: { done, total } }),
      downloadAbort.signal,
    );
    downloadAbort = null;
    return file;
  });
  handle('app:cancelDownload', () => downloadAbort?.abort());
  handle('app:installUpdate', async (file: string) => {
    const kind = installKind();
    if (kind === 'windows') {
      // l'installateur NSIS remplace l'application : on le lance puis on quitte
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
      setTimeout(() => app.quit(), 800);
      return 'started';
    }
    if (kind === 'appimage' && process.env.APPIMAGE) {
      // remplacer l'AppImage en place puis relancer
      const target = process.env.APPIMAGE;
      fs.copyFileSync(file, target + '.new');
      fs.chmodSync(target + '.new', 0o755);
      fs.renameSync(target + '.new', target);
      app.relaunch({ execPath: target, args: process.argv.slice(1) });
      setTimeout(() => app.exit(0), 300);
      return 'relaunch';
    }
    if (kind === 'mac') {
      // ouvre l'image disque : glisser KSDB Studio dans Applications pour remplacer l'ancienne version
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
      setTimeout(() => app.quit(), 1500);
      return 'dmg';
    }
    shell.showItemInFolder(file);
    return 'manual';
  });

  // vérification automatique : 10 s après le démarrage puis toutes les 6 h
  const auto = () => {
    if (store.settings().checkUpdates !== false) runCheck(false).catch(() => {});
  };
  setTimeout(auto, 10_000);
  setInterval(auto, 6 * 3600_000);

  return {
    shutdown: async () => {
      await cm.disconnectAll();
      await vpn.stopOwned(store.vpnProfiles());
    },
  };
}
