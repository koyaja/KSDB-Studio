// Sauvegarde / restauration via les outils officiels (pg_dump, pg_restore, psql, mysqldump, mysql).
import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ConnectionConfig, DumpOptions, RestoreOptions, Settings, ToolStatus } from '../shared/types';
import type { Endpoint } from './drivers/base';

type ToolName = keyof Settings['binaries'];
const TOOL_NAMES: ToolName[] = ['pg_dump', 'pg_restore', 'psql', 'mysqldump', 'mysql'];
const isWin = process.platform === 'win32';
const exe = (n: string) => (isWin ? `${n}.exe` : n);

function versionKey(dir: string): number {
  const m = /(\d+)(?:\.(\d+))?/.exec(path.basename(path.dirname(dir)) + ' ' + dir);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 0) : 0;
}

function candidateDirs(name: ToolName): string[] {
  const dirs: string[] = [];
  const glob = (base: string, pattern: RegExp, sub: string) => {
    try {
      for (const d of fs.readdirSync(base)) if (pattern.test(d)) dirs.push(path.join(base, d, sub));
    } catch {
      /* dossier absent */
    }
  };
  const pgTool = name.startsWith('pg_') || name === 'psql';
  if (isWin) {
    for (const pf of [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (!pf) continue;
      if (pgTool) glob(path.join(pf, 'PostgreSQL'), /^\d+/, 'bin');
      else {
        glob(path.join(pf, 'MySQL'), /^MySQL (Server|Workbench)/i, '');
        glob(path.join(pf, 'MySQL'), /^MySQL Server/i, 'bin');
        glob(pf, /^MariaDB/i, 'bin');
      }
    }
    if (!pgTool) {
      dirs.push('C:\\xampp\\mysql\\bin', 'C:\\wamp64\\bin\\mysql', 'C:\\laragon\\bin\\mysql');
      glob('C:\\wamp64\\bin\\mysql', /^mysql/i, 'bin');
      glob('C:\\laragon\\bin\\mysql', /^mysql/i, 'bin');
    }
  } else {
    if (pgTool) glob('/usr/lib/postgresql', /^\d+/, 'bin');
    dirs.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/usr/local/mysql/bin');
  }
  return dirs.sort((a, b) => versionKey(b) - versionKey(a));
}

function which(name: string): string | null {
  const r = spawnSync(isWin ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  const first = r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean) : undefined;
  return first?.trim() || null;
}

export function findTool(name: ToolName, settings: Settings): string | null {
  const custom = settings.binaries[name];
  if (custom && fs.existsSync(custom)) return custom;
  // Les versions installées dans des dossiers versionnés passent avant le PATH (pg_dump doit être >= serveur)
  for (const d of candidateDirs(name)) {
    const p = path.join(d, exe(name));
    if (fs.existsSync(p)) return p;
  }
  return which(name);
}

export function toolStatus(settings: Settings): ToolStatus[] {
  return TOOL_NAMES.map((name) => {
    const p = findTool(name, settings);
    let version: string | null = null;
    if (p) {
      const r = spawnSync(p, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      version = (r.stdout || r.stderr || '').trim().split('\n')[0] || null;
    }
    return { name, path: p, version };
  });
}

function isMariaClient(tool: string): boolean {
  const r = spawnSync(tool, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  return /mariadb/i.test(r.stdout + r.stderr);
}

function mysqlSslArgs(cfg: ConnectionConfig, maria: boolean): string[] {
  if (maria) {
    if (cfg.ssl.mode === 'disable') return ['--skip-ssl'];
    if (cfg.ssl.mode === 'require') return ['--ssl', '--skip-ssl-verify-server-cert'];
    return ['--ssl', '--ssl-verify-server-cert', ...(cfg.ssl.caPath ? [`--ssl-ca=${cfg.ssl.caPath}`] : [])];
  }
  if (cfg.ssl.mode === 'disable') return ['--ssl-mode=DISABLED'];
  if (cfg.ssl.mode === 'require') return ['--ssl-mode=REQUIRED'];
  return ['--ssl-mode=VERIFY_CA', ...(cfg.ssl.caPath ? [`--ssl-ca=${cfg.ssl.caPath}`] : [])];
}

function pgEnv(cfg: ConnectionConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PGPASSWORD: cfg.password ?? '', PGCONNECT_TIMEOUT: '15' };
  env.PGSSLMODE = cfg.ssl.mode === 'disable' ? 'disable' : cfg.ssl.mode === 'require' ? 'require' : 'verify-ca';
  if (cfg.ssl.mode === 'verify' && cfg.ssl.caPath) env.PGSSLROOTCERT = cfg.ssl.caPath;
  return env;
}

function myEnv(cfg: ConnectionConfig): NodeJS.ProcessEnv {
  return { ...process.env, MYSQL_PWD: cfg.password ?? '' };
}

export interface Job {
  child: ChildProcess | null;
  cancelled: boolean;
}

export interface JobSink {
  log: (m: string) => void;
  progress: (p: number) => void;
}

function run(
  job: Job,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  sink: JobSink,
  opts: { stdinFile?: string; stdoutFile?: string } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    sink.log(`$ ${path.basename(cmd)} ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`);
    const child = spawn(cmd, args, { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    job.child = child;
    const lines = (buf: Buffer) =>
      buf
        .toString('utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .forEach((l) => sink.log(l));
    child.stderr!.on('data', lines);
    if (opts.stdoutFile) {
      const out = fs.createWriteStream(opts.stdoutFile);
      child.stdout!.pipe(out);
    } else child.stdout!.on('data', lines);
    if (opts.stdinFile) {
      const size = fs.statSync(opts.stdinFile).size || 1;
      let read = 0;
      const input = fs.createReadStream(opts.stdinFile);
      input.on('data', (c) => {
        read += c.length;
        sink.progress(Math.min(1, read / size));
      });
      input.pipe(child.stdin!);
      child.stdin!.on('error', () => input.destroy());
    } else child.stdin!.end();
    child.on('error', (e) => reject(new Error(`Impossible de lancer ${cmd} : ${e.message}`)));
    child.on('close', (code) => {
      job.child = null;
      if (job.cancelled) reject(new Error('Opération annulée'));
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} a terminé avec le code ${code}`));
    });
  });
}

function need(name: ToolName, settings: Settings): string {
  const p = findTool(name, settings);
  if (!p)
    throw new Error(
      `${name} introuvable. Installe les outils clients ${name.startsWith('my') ? 'MySQL/MariaDB' : 'PostgreSQL'} ` +
        `ou indique leur chemin dans Paramètres > Outils.`,
    );
  return p;
}

export async function dump(
  job: Job,
  cfg: ConnectionConfig,
  ep: Endpoint,
  o: DumpOptions,
  settings: Settings,
  sink: JobSink,
): Promise<void> {
  if (cfg.kind === 'postgres') {
    const tool = need('pg_dump', settings);
    const args = ['-h', ep.host, '-p', String(ep.port), '-U', cfg.user, '-d', o.database, '--no-password', '-v'];
    args.push('-F', o.format === 'custom' ? 'c' : 'p', '-f', o.filePath);
    if (o.content === 'schema') args.push('-s');
    if (o.content === 'data') args.push('-a');
    for (const s of o.schemas ?? []) args.push('-n', s);
    for (const t of o.tables ?? []) args.push('-t', t);
    if (o.createDatabase) args.push('-C');
    if (o.dropObjects) args.push('-c', '--if-exists');
    if (o.noOwner) args.push('-O', '-x');
    await run(job, tool, args, pgEnv(cfg), sink);
  } else {
    const tool = need('mysqldump', settings);
    const maria = isMariaClient(tool);
    const args = ['-h', ep.host, '-P', String(ep.port), '-u', cfg.user, '--protocol=TCP'];
    args.push('--single-transaction', '--routines', '--triggers', '--events', '--default-character-set=utf8mb4', '--hex-blob');
    args.push(...mysqlSslArgs(cfg, maria));
    if (!maria) args.push('--column-statistics=0', '--set-gtid-purged=OFF');
    if (o.content === 'schema') args.push('--no-data');
    if (o.content === 'data') args.push('--no-create-info', '--skip-triggers');
    if (o.dropObjects === false) args.push('--skip-add-drop-table');
    args.push(`--result-file=${o.filePath}`);
    if (o.createDatabase) args.push('--databases', o.database);
    else {
      args.push(o.database);
      for (const t of o.tables ?? []) args.push(t);
    }
    await run(job, tool, args, myEnv(cfg), sink);
  }
  const size = fs.statSync(o.filePath).size;
  sink.log(`Fichier écrit : ${o.filePath} (${(size / 1024 / 1024).toFixed(2)} Mo)`);
}

function isPgArchive(file: string): boolean {
  try {
    if (fs.statSync(file).isDirectory()) return true;
    const fd = fs.openSync(file, 'r');
    const b = Buffer.alloc(5);
    fs.readSync(fd, b, 0, 5, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === 'PGDMP';
  } catch {
    return false;
  }
}

export async function restore(
  job: Job,
  cfg: ConnectionConfig,
  ep: Endpoint,
  o: RestoreOptions,
  settings: Settings,
  sink: JobSink,
): Promise<void> {
  if (cfg.kind === 'postgres') {
    if (isPgArchive(o.filePath)) {
      const tool = need('pg_restore', settings);
      const args = ['-h', ep.host, '-p', String(ep.port), '-U', cfg.user, '-d', o.database, '--no-password', '-v'];
      if (o.clean) args.push('--clean', '--if-exists');
      if (o.noOwner) args.push('-O', '-x');
      if (o.jobs && o.jobs > 1) args.push('-j', String(o.jobs));
      args.push(o.filePath);
      await run(job, tool, args, pgEnv(cfg), sink);
    } else {
      const tool = need('psql', settings);
      const args = ['-h', ep.host, '-p', String(ep.port), '-U', cfg.user, '-d', o.database, '--no-password'];
      args.push('-v', 'ON_ERROR_STOP=1', '-q');
      await run(job, tool, args, pgEnv(cfg), sink, { stdinFile: o.filePath });
    }
  } else {
    const tool = need('mysql', settings);
    const maria = isMariaClient(tool);
    const args = ['-h', ep.host, '-P', String(ep.port), '-u', cfg.user, '--protocol=TCP', '--default-character-set=utf8mb4'];
    args.push(...mysqlSslArgs(cfg, maria));
    args.push(o.database);
    await run(job, tool, args, myEnv(cfg), sink, { stdinFile: o.filePath });
  }
  sink.log('Restauration terminée.');
}
