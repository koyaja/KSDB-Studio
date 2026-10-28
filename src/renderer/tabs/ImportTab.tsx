import { FolderOpen, Play } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ColumnInfo, CsvPreview } from '../../shared/types';
import { api } from '../api';
import { Field, fmtInt } from '../components/ui';
import { trackJob } from '../jobs';
import { confirmDialog, connectionById, openTab, Tab, toast, uid } from '../state';

type ITab = Extract<Tab, { kind: 'import' }>;

const DELIMS: [string, string][] = [
  [',', 'Virgule'],
  [';', 'Point-virgule'],
  ['\t', 'Tabulation'],
  ['|', 'Barre |'],
];

export function ImportTab({ tab, active }: { tab: ITab; active: boolean }) {
  const [file, setFile] = useState('');
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [delimiter, setDelimiter] = useState<string | undefined>(undefined);
  const [encoding, setEncoding] = useState<'utf8' | 'latin1'>('utf8');
  const [header, setHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [truncate, setTruncate] = useState(false);
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [mapping, setMapping] = useState<string[]>([]);
  const [status, setStatus] = useState('');
  const [running, setRunning] = useState(false);

  useEffect(() => {
    api.structure(tab.connectionId, tab.database, tab.schema, tab.table).then((s) => setColumns(s.columns)).catch((e) => toast(e.message, 'error'));
  }, [tab.connectionId, tab.database, tab.schema, tab.table]);

  useEffect(() => {
    if (!file) return;
    api
      .csvPreview(file, delimiter, encoding)
      .then((p) => {
        setPreview(p);
        if (!delimiter) setDelimiter(p.delimiter);
        const names = columns.map((c) => c.name);
        const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
        const n = Math.max(p.headers.length, p.rows[0]?.length ?? 0);
        setMapping(
          Array.from({ length: n }, (_, i) => {
            const h = (p.headers[i] ?? '').trim().toLowerCase();
            return header ? lower.get(h) ?? '' : names[i] ?? '';
          }),
        );
      })
      .catch((e) => toast(e.message, 'error'));
  }, [file, delimiter, encoding, columns, header]);

  const pick = async () => {
    const f = await api.openDialog({ properties: ['openFile'], filters: [{ name: 'CSV / TSV', extensions: ['csv', 'tsv', 'txt'] }] });
    if (f?.[0]) {
      setDelimiter(undefined);
      setFile(f[0]);
    }
  };

  const run = async () => {
    const map = mapping.map((column, csvIndex) => ({ csvIndex, column })).filter((m) => m.column);
    if (!map.length) return toast('Associe au moins une colonne.', 'error');
    if (truncate && !(await confirmDialog(`Vider ${tab.table} avant l’import ?`, 'Les lignes actuelles seront supprimées (dans la même transaction).', { danger: true, confirmLabel: 'Vider et importer' }))) return;
    setRunning(true);
    setStatus('Démarrage…');
    const t = trackJob(
      api.importCsv({ connectionId: tab.connectionId, database: tab.database, schema: tab.schema, table: tab.table, filePath: file, delimiter: delimiter ?? ',', header, emptyAsNull, truncate, encoding, mapping: map }),
      (ev) => ev.kind === 'log' && setStatus(ev.message ?? ''),
    );
    try {
      const msg = await t.done;
      setStatus(msg);
      toast(msg, 'success');
    } catch (e) {
      setStatus('');
      toast(`Import annulé, aucune ligne insérée.\n${(e as Error).message}`, 'error');
    } finally {
      setRunning(false);
    }
  };

  const ncols = mapping.length;

  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="page">
        <h2>Importer un CSV dans {tab.table}</h2>
        <p className="lead">Tout l’import se fait dans une seule transaction : en cas d’erreur sur une ligne, la table reste inchangée.</p>
        <div className="form-grid" style={{ maxWidth: 900 }}>
          <Field label="Fichier" className="full">
            <div className="form-row">
              <input className="input mono" style={{ flex: 1 }} value={file} readOnly />
              <button className="btn outline" onClick={pick}>
                <FolderOpen /> Parcourir…
              </button>
            </div>
          </Field>
          <Field label="Séparateur">
            <div className="seg">
              {DELIMS.map(([d, l]) => (
                <button key={l} className={delimiter === d ? 'active' : ''} onClick={() => setDelimiter(d)}>
                  {l}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Encodage">
            <div className="seg">
              <button className={encoding === 'utf8' ? 'active' : ''} onClick={() => setEncoding('utf8')}>
                UTF-8
              </button>
              <button className={encoding === 'latin1' ? 'active' : ''} onClick={() => setEncoding('latin1')}>
                Windows / Latin-1
              </button>
            </div>
          </Field>
          <label className="check">
            <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} /> Première ligne = en-têtes
          </label>
          <label className="check">
            <input type="checkbox" checked={emptyAsNull} onChange={(e) => setEmptyAsNull(e.target.checked)} /> Champs vides → NULL
          </label>
          <label className="check">
            <input type="checkbox" checked={truncate} onChange={(e) => setTruncate(e.target.checked)} /> Vider la table avant
          </label>
        </div>

        {preview && (
          <>
            <h2>Correspondance des colonnes</h2>
            <div style={{ overflow: 'auto', border: '1px solid var(--line)', borderRadius: 6 }}>
              <table className="plain" style={{ width: 'max-content', minWidth: '100%' }}>
                <thead>
                  <tr>
                    {Array.from({ length: ncols }, (_, i) => (
                      <th key={i} style={{ minWidth: 150 }}>
                        <select
                          className="input small"
                          style={{ width: '100%', borderColor: mapping[i] ? 'var(--accent)' : undefined }}
                          value={mapping[i] ?? ''}
                          onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? e.target.value : x)))}
                        >
                          <option value="">— ignorer —</option>
                          {columns.map((c) => (
                            <option key={c.name} value={c.name}>
                              {c.name} ({c.type})
                            </option>
                          ))}
                        </select>
                        {header && <div className="hint mono" style={{ marginTop: 4 }}>{preview.headers[i]}</div>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(header ? preview.rows : [preview.headers, ...preview.rows]).slice(0, 12).map((r, i) => (
                    <tr key={i}>
                      {Array.from({ length: ncols }, (_, j) => (
                        <td key={j} className="mono" style={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: mapping[j] ? 1 : 0.45 }}>
                          {r[j]}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint">Aperçu des {fmtInt(Math.min(12, preview.rows.length))} premières lignes.</p>
            <div className="form-row" style={{ marginTop: 10, alignItems: 'center' }}>
              <button className="btn primary" disabled={running} onClick={run}>
                <Play /> Importer
              </button>
              <span className="hint">{status}</span>
              {status && !running && (
                <button
                  className="btn"
                  onClick={() => openTab({ id: uid(), kind: 'table', connectionId: tab.connectionId, database: tab.database, schema: tab.schema, table: tab.table, objType: 'table', view: 'data' })}
                >
                  Voir les données de {connectionById(tab.connectionId) ? tab.table : ''}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
