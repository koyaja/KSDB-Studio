// Découpage d'un script SQL en instructions, en respectant chaînes,
// commentaires, dollar-quoting (PostgreSQL) et DELIMITER (MySQL).

import type { DbKind } from './types';

export interface SqlStatement {
  text: string;
  start: number;
  end: number;
}

export function splitSql(sql: string, kind: DbKind): SqlStatement[] {
  const out: SqlStatement[] = [];
  const n = sql.length;
  let delimiter = ';';
  let stmtStart = 0;
  let i = 0;

  const push = (end: number, nextStart: number) => {
    const raw = sql.slice(stmtStart, end);
    const text = raw.trim();
    if (text && !isOnlyComments(text, kind)) {
      const lead = raw.length - raw.trimStart().length;
      out.push({ text, start: stmtStart + lead, end: stmtStart + lead + text.length });
    }
    stmtStart = nextStart;
  };

  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];

    // DELIMITER (MySQL) : seulement en début de ligne
    if (kind === 'mysql' && (i === 0 || sql[i - 1] === '\n') && /^delimiter\s/i.test(sql.slice(i, i + 10))) {
      const lineEnd = sql.indexOf('\n', i);
      const line = sql.slice(i, lineEnd === -1 ? n : lineEnd);
      if (sql.slice(stmtStart, i).trim()) push(i, i);
      delimiter = line.trim().split(/\s+/)[1] || ';';
      i = lineEnd === -1 ? n : lineEnd + 1;
      stmtStart = i;
      continue;
    }

    // Commentaire ligne
    if ((c === '-' && next === '-') || (kind === 'mysql' && c === '#')) {
      const e = sql.indexOf('\n', i);
      i = e === -1 ? n : e + 1;
      continue;
    }
    // Commentaire bloc (imbriqués en PG)
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (kind === 'postgres' && sql[i] === '/' && sql[i + 1] === '*') { depth++; i += 2; continue; }
        if (sql[i] === '*' && sql[i + 1] === '/') { depth--; i += 2; continue; }
        i++;
      }
      continue;
    }
    // Chaînes
    if (c === "'" || (c === '"') || (kind === 'mysql' && c === '`')) {
      const backslash =
        kind === 'mysql' ? c !== '`' : c === "'" && i > 0 && /[eE]/.test(sql[i - 1]) && !/\w/.test(sql[i - 2] || '');
      i++;
      while (i < n) {
        if (backslash && sql[i] === '\\') { i += 2; continue; }
        if (sql[i] === c) {
          if (sql[i + 1] === c) { i += 2; continue; }
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    // Dollar quoting PG
    if (kind === 'postgres' && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m && !/[A-Za-z0-9_]/.test(sql[i - 1] || '')) {
        const tag = m[0];
        const close = sql.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    // Délimiteur
    if (sql.startsWith(delimiter, i)) {
      push(i, i + delimiter.length);
      i += delimiter.length;
      continue;
    }
    i++;
  }
  push(n, n);
  return out;
}

function isOnlyComments(text: string, kind: DbKind): boolean {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
    .replace(kind === 'mysql' ? /#[^\n]*/g : /$^/, '')
    .trim();
  return stripped.length === 0;
}

/** Instruction sous le curseur (ou la dernière avant le curseur). */
export function statementAt(sql: string, kind: DbKind, pos: number): SqlStatement | null {
  const list = splitSql(sql, kind);
  if (!list.length) return null;
  let best: SqlStatement | null = null;
  for (const s of list) {
    if (pos >= s.start && pos <= s.end + 1) return s;
    if (s.end < pos) best = s;
  }
  return best ?? list[0];
}

const DESTRUCTIVE = /^\s*(drop|truncate|alter\s+table\s+\S+\s+drop)\b/i;

/** Détecte une instruction risquée (pour les connexions marquées production). */
export function isRisky(stmt: string): string | null {
  const s = stmt.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim();
  if (DESTRUCTIVE.test(s)) return 'Instruction destructive (DROP/TRUNCATE)';
  if (/^\s*(delete|update)\b/i.test(s) && !/\bwhere\b/i.test(s)) return 'DELETE/UPDATE sans clause WHERE';
  return null;
}

/** Une instruction renvoie-t-elle probablement des lignes ? */
export function returnsRows(stmt: string): boolean {
  const s = stmt.replace(/^(\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)+/, '').toLowerCase();
  return /^(select|with|show|explain|describe|desc|values|table|pragma|call|analyze)\b/.test(s) ||
    /\breturning\b/.test(s);
}
