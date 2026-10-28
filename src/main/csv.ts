// Lecture et écriture CSV (RFC 4180) en flux.
import fs from 'node:fs';
import type { CellValue, CsvPreview, ExportFormat, ResultField } from '../shared/types';

export class CsvParser {
  private field = '';
  private row: string[] = [];
  private inQuotes = false;
  private quoteSeen = false;
  rows: string[][] = [];

  constructor(private delim: string) {}

  feed(chunk: string) {
    const d = this.delim;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i];
      if (this.inQuotes) {
        if (c === '"') {
          if (chunk[i + 1] === '"') {
            this.field += '"';
            i++;
          } else if (i + 1 === chunk.length) {
            // guillemet en fin de chunk : on ne sait pas encore s'il est doublé
            this.quoteSeen = true;
            this.inQuotes = false;
          } else this.inQuotes = false;
        } else this.field += c;
        continue;
      }
      if (this.quoteSeen) {
        this.quoteSeen = false;
        if (c === '"') {
          this.field += '"';
          this.inQuotes = true;
          continue;
        }
      }
      if (c === '"' && this.field === '') this.inQuotes = true;
      else if (c === d) {
        this.row.push(this.field);
        this.field = '';
      } else if (c === '\n') {
        this.row.push(this.field.endsWith('\r') ? this.field.slice(0, -1) : this.field);
        this.rows.push(this.row);
        this.row = [];
        this.field = '';
      } else this.field += c;
    }
  }

  end() {
    if (this.field !== '' || this.row.length) {
      this.row.push(this.field.endsWith('\r') ? this.field.slice(0, -1) : this.field);
      this.rows.push(this.row);
    }
    this.row = [];
    this.field = '';
  }

  take(): string[][] {
    const r = this.rows;
    this.rows = [];
    return r;
  }
}

export function detectDelimiter(firstLine: string): string {
  const cands = [',', ';', '\t', '|'];
  let best = ',';
  let bestN = -1;
  for (const c of cands) {
    const n = firstLine.split(c).length - 1;
    if (n > bestN) {
      best = c;
      bestN = n;
    }
  }
  return best;
}

export async function previewCsv(filePath: string, delimiter: string | undefined, encoding: BufferEncoding): Promise<CsvPreview> {
  const fd = await fs.promises.open(filePath, 'r');
  const buf = Buffer.alloc(128 * 1024);
  const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
  await fd.close();
  let text = buf.subarray(0, bytesRead).toString(encoding);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delim = delimiter || detectDelimiter(text.split('\n')[0] ?? '');
  const p = new CsvParser(delim);
  p.feed(text);
  const rows = p.take().slice(0, 51);
  return { headers: rows[0] ?? [], rows: rows.slice(1, 51), delimiter: delim };
}

export async function* readCsvBatches(
  filePath: string,
  delimiter: string,
  encoding: BufferEncoding,
  skipHeader: boolean,
  batchSize: number,
): AsyncGenerator<string[][]> {
  const stream = fs.createReadStream(filePath, { encoding, highWaterMark: 256 * 1024 });
  const p = new CsvParser(delimiter);
  let first = true;
  let pending: string[][] = [];
  for await (const chunk of stream as AsyncIterable<string>) {
    let text = chunk;
    if (first && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    p.feed(text);
    let rows = p.take();
    if (first && skipHeader) rows = rows.slice(1);
    first = false;
    pending.push(...rows);
    while (pending.length >= batchSize) {
      yield pending.slice(0, batchSize);
      pending = pending.slice(batchSize);
    }
  }
  p.end();
  let rest = p.take();
  if (first && skipHeader) rest = rest.slice(1);
  pending.push(...rest);
  if (pending.length) yield pending;
}

// ---------- Écriture ----------

function csvField(v: CellValue, delim: string): string {
  if (v === null) return '';
  const s = String(v);
  if (s.includes(delim) || s.includes('"') || s.includes('\n') || s.includes('\r')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export interface Writer {
  header(fields: ResultField[]): string;
  rows(rows: CellValue[][], fields: ResultField[]): string;
  footer(): string;
}

export function makeWriter(
  format: ExportFormat,
  opts: { table?: string; literal: (v: CellValue) => string; quoteIdent: (s: string) => string },
): Writer {
  if (format === 'csv' || format === 'tsv') {
    const d = format === 'csv' ? ',' : '\t';
    return {
      header: (f) => f.map((x) => csvField(x.name, d)).join(d) + '\r\n',
      rows: (rows) => rows.map((r) => r.map((v) => csvField(v, d)).join(d)).join('\r\n') + (rows.length ? '\r\n' : ''),
      footer: () => '',
    };
  }
  if (format === 'json') {
    let first = true;
    return {
      header: () => '[\n',
      rows: (rows, fields) =>
        rows
          .map((r) => {
            const o: Record<string, CellValue> = {};
            fields.forEach((f, i) => (o[f.name] = r[i]));
            const s = (first ? '  ' : ',\n  ') + JSON.stringify(o);
            first = false;
            return s;
          })
          .join(''),
      footer: () => '\n]\n',
    };
  }
  // SQL INSERT
  const table = opts.table ?? 'export';
  return {
    header: () => `-- Export KSDB Studio\n`,
    rows: (rows, fields) => {
      if (!rows.length) return '';
      const cols = fields.map((f) => opts.quoteIdent(f.name)).join(', ');
      let out = '';
      for (let i = 0; i < rows.length; i += 100) {
        const chunk = rows.slice(i, i + 100);
        out += `INSERT INTO ${table} (${cols}) VALUES\n` + chunk.map((r) => '  (' + r.map(opts.literal).join(', ') + ')').join(',\n') + ';\n';
      }
      return out;
    },
    footer: () => '',
  };
}
