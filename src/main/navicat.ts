// Import des connexions exportées depuis Navicat (fichier .ncx).
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import type { ConnectionConfig } from '../shared/types';

// Navicat 12+ : AES-128-CBC avec clé et IV publics.
const KEY = Buffer.from('libcckeylibcckey');
const IV = Buffer.from('libcciv libcciv ');

export function decryptNavicat(hex: string | undefined): string {
  if (!hex) return '';
  try {
    const d = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
    return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function encryptNavicat(plain: string): string {
  const c = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([c.update(plain, 'utf8'), c.final()]).toString('hex').toUpperCase();
}

const truthy = (v: unknown) => String(v).toLowerCase() === 'true';

export interface NavicatImport {
  connections: Omit<ConnectionConfig, 'id'>[];
  skipped: { name: string; type: string }[];
}

export function parseNcx(xml: string): NavicatImport {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
  const doc = parser.parse(xml);
  const raw = doc?.Connections?.Connection;
  const list: Record<string, string>[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out: NavicatImport = { connections: [], skipped: [] };
  for (const c of list) {
    const type = String(c.ConnType ?? '').toUpperCase();
    const name = String(c.ConnectionName ?? c.Host ?? 'Connexion Navicat');
    const isPg = type.includes('POSTGRE');
    const isMy = type.includes('MYSQL') || type.includes('MARIADB');
    if (!isPg && !isMy) {
      out.skipped.push({ name, type });
      continue;
    }
    const password = decryptNavicat(c.Password);
    const sshOn = truthy(c.SSH);
    const keyAuth = String(c.SSH_AuthenMethod ?? '').toUpperCase().includes('PUBLICKEY');
    out.connections.push({
      name,
      kind: isPg ? 'postgres' : 'mysql',
      flavor: isPg ? 'postgres' : type.includes('MARIADB') ? 'mariadb' : 'mysql',
      host: String(c.Host ?? 'localhost'),
      port: Number(c.Port) || (isPg ? 5432 : 3306),
      user: String(c.UserName ?? ''),
      password,
      savePassword: c.SavePassword === undefined ? !!password : truthy(c.SavePassword) || !!password,
      database: String(c.Database ?? c.InitialDatabase ?? c.DatabaseName ?? '') || undefined,
      group: 'Navicat',
      ssl: { mode: truthy(c.SSL) ? 'require' : 'disable' },
      ssh: {
        enabled: sshOn,
        host: String(c.SSH_Host ?? ''),
        port: Number(c.SSH_Port) || 22,
        user: String(c.SSH_UserName ?? ''),
        auth: keyAuth ? 'key' : 'password',
        password: decryptNavicat(c.SSH_Password),
        keyPath: c.SSH_PrivateKey ? String(c.SSH_PrivateKey) : undefined,
        passphrase: decryptNavicat(c.SSH_Passphrase),
      },
    });
  }
  return out;
}
