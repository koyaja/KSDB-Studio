import { useState } from 'react';
import type { ExportFormat } from '../../shared/types';
import { api } from '../api';
import { trackJob } from '../jobs';
import { toast } from '../state';
import { Field, Modal } from './ui';

export const FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'csv', label: 'CSV', ext: 'csv' },
  { id: 'tsv', label: 'TSV (Excel collé)', ext: 'tsv' },
  { id: 'json', label: 'JSON', ext: 'json' },
  { id: 'sql', label: 'SQL INSERT', ext: 'sql' },
];

export interface ExportTarget {
  connectionId: string;
  database: string;
  schema: string;
  table: string;
  where?: string;
}

export function ExportTableDialog(props: { target: ExportTarget; onClose: () => void }) {
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [where, setWhere] = useState(props.target.where ?? '');
  const [bom, setBom] = useState(true);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const go = async () => {
    const f = FORMATS.find((x) => x.id === format)!;
    const file = await api.saveDialog({
      title: 'Exporter la table',
      defaultPath: `${props.target.table}.${f.ext}`,
      filters: [{ name: f.label, extensions: [f.ext] }],
    });
    if (!file) return;
    setRunning(true);
    const { done } = trackJob(
      api.exportTable({ ...props.target, where, format, filePath: file, csvBom: bom }),
      (ev) => ev.kind === 'log' && setStatus(ev.message ?? null),
    );
    try {
      const msg = await done;
      toast(msg, 'success');
      api.showItem(file).catch(() => {});
      props.onClose();
    } catch (e) {
      toast((e as Error).message, 'error');
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`Exporter ${props.target.table}`}
      onClose={props.onClose}
      footer={
        <>
          <button className="btn outline" onClick={props.onClose}>
            Annuler
          </button>
          <button className="btn primary" onClick={go} disabled={running}>
            {running ? 'Export en cours…' : 'Choisir le fichier et exporter'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Field label="Format">
          <div className="seg">
            {FORMATS.map((f) => (
              <button key={f.id} className={format === f.id ? 'active' : ''} onClick={() => setFormat(f.id)}>
                {f.label}
              </button>
            ))}
          </div>
        </Field>
        <Field label="Filtre WHERE (facultatif)" hint="Toutes les lignes sont exportées, pas seulement la page affichée.">
          <input className="input mono" value={where} placeholder="ex. statut = 'payee' AND montant > 1000" onChange={(e) => setWhere(e.target.value)} />
        </Field>
        {format === 'csv' && (
          <label className="check">
            <input type="checkbox" checked={bom} onChange={(e) => setBom(e.target.checked)} />
            Ajouter un BOM UTF-8 (accents corrects à l’ouverture dans Excel)
          </label>
        )}
        {status && <div className="hint">{status}</div>}
      </div>
    </Modal>
  );
}
