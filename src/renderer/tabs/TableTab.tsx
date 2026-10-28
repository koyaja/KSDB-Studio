import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Code2,
  Copy,
  FileCode,
  FileDown,
  Filter,
  Info,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CellValue, RowChange, TablePage, TableStructure } from '../../shared/types';
import { qualified } from '../actions';
import { api } from '../api';
import { DataGrid, GridHandle } from '../components/DataGrid';
import { openExport } from '../components/Sidebar';
import { SqlEditor } from '../components/SqlEditor';
import { fmtInt, formatDuration, Modal } from '../components/ui';
import { confirmDialog, connectionById, newQueryTab, openTab, Tab, toast, uid, updateTab, useApp } from '../state';

type TTab = Extract<Tab, { kind: 'table' }>;

export function TableTab({ tab, active }: { tab: TTab; active: boolean }) {
  const isRel = tab.objType === 'table' || tab.objType === 'view' || tab.objType === 'matview';
  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="toolbar">
        <div className="subtabs" role="tablist">
          {isRel && (
            <button role="tab" className={tab.view === 'data' ? 'active' : ''} onClick={() => updateTab(tab.id, { view: 'data' })}>
              Données
            </button>
          )}
          {isRel && (
            <button role="tab" className={tab.view === 'structure' ? 'active' : ''} onClick={() => updateTab(tab.id, { view: 'structure' })}>
              Structure
            </button>
          )}
          <button role="tab" className={tab.view === 'ddl' ? 'active' : ''} onClick={() => updateTab(tab.id, { view: 'ddl' })}>
            DDL
          </button>
        </div>
        <span className="hint mono">{tab.objType === 'table' || tab.objType === 'view' ? `${tab.database}.${tab.schema !== tab.database ? tab.schema + '.' : ''}${tab.table}` : tab.table}</span>
        <span className="grow" />
        {tab.objType === 'table' && (
          <button className="btn" onClick={() => openTab({ id: uid(), kind: 'designer', connectionId: tab.connectionId, database: tab.database, schema: tab.schema, table: tab.table })}>
            <Pencil /> Modifier la structure
          </button>
        )}
      </div>
      {tab.view === 'data' && <DataView tab={tab} active={active} />}
      {tab.view === 'structure' && <StructureView tab={tab} />}
      {tab.view === 'ddl' && <DdlView tab={tab} />}
    </div>
  );
}

// ---------------- Données ----------------
function DataView({ tab, active }: { tab: TTab; active: boolean }) {
  const settings = useApp((s) => s.settings);
  const conn = useApp((s) => s.connections.find((c) => c.id === tab.connectionId));
  const [page, setPage] = useState<TablePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [offset, setOffset] = useState(0);
  const [limit, setLimit] = useState(settings.pageSize);
  const [whereInput, setWhereInput] = useState(tab.where ?? '');
  const [where, setWhere] = useState(tab.where ?? '');
  const [orderBy, setOrderBy] = useState<{ column: string; dir: 'asc' | 'desc' }[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [edits, setEdits] = useState<Map<number, Map<number, CellValue>>>(new Map());
  const [added, setAdded] = useState(0);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const grid = useRef<GridHandle>(null);

  const dirty = edits.size > 0 || added > 0 || deleted.size > 0;

  const resetEdits = () => {
    setEdits(new Map());
    setAdded(0);
    setDeleted(new Set());
    setSelected(new Set());
  };

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const p = await api.page(tab.connectionId, tab.database, tab.schema, tab.table, { limit, offset, where, orderBy });
      setPage(p);
      resetEdits();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.database, tab.schema, tab.table, limit, offset, where, orderBy]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    setTotal(null);
    api.count(tab.connectionId, tab.database, tab.schema, tab.table, where).then(setTotal).catch(() => setTotal(null));
  }, [tab.connectionId, tab.database, tab.schema, tab.table, where]);

  const guard = async (fn: () => void) => {
    if (dirty && !(await confirmDialog('Abandonner les modifications non enregistrées ?', undefined, { danger: true, confirmLabel: 'Abandonner' }))) return;
    fn();
  };

  const hidden = useMemo(() => {
    const s = new Set<number>();
    if (page?.hiddenKey) s.add(page.fields.findIndex((f) => f.name === page.hiddenKey));
    return s;
  }, [page]);

  const baseCount = page?.rows.length ?? 0;
  const rows = useMemo(() => {
    if (!page) return [];
    const width = page.fields.length;
    const all: CellValue[][] = [...page.rows, ...Array.from({ length: added }, () => new Array<CellValue>(width).fill(null))];
    if (!edits.size) return all;
    return all.map((r, i) => {
      const e = edits.get(i);
      if (!e) return r;
      const copy = r.slice();
      e.forEach((v, c) => (copy[c] = v));
      return copy;
    });
  }, [page, edits, added]);

  const onEdit = (r: number, c: number, v: CellValue) => {
    setEdits((prev) => {
      const next = new Map(prev);
      const m = new Map(next.get(r) ?? []);
      if (r < baseCount && String(page!.rows[r][c] ?? '\u0000') === String(v ?? '\u0000')) m.delete(c);
      else m.set(c, v);
      if (m.size) next.set(r, m);
      else next.delete(r);
      return next;
    });
  };

  const keyOf = (r: number): Record<string, CellValue> => {
    const p = page!;
    const cols = p.hiddenKey ? [p.hiddenKey] : p.keyColumns;
    const key: Record<string, CellValue> = {};
    for (const k of cols) key[k] = p.rows[r][p.fields.findIndex((f) => f.name === k)];
    return key;
  };

  const buildChanges = (): RowChange[] => {
    const p = page!;
    const out: RowChange[] = [];
    edits.forEach((m, r) => {
      if (r >= baseCount || deleted.has(r)) return;
      const set: Record<string, CellValue> = {};
      m.forEach((v, c) => (set[p.fields[c].name] = v));
      out.push({ type: 'update', key: keyOf(r), set });
    });
    for (let i = 0; i < added; i++) {
      const values: Record<string, CellValue> = {};
      edits.get(baseCount + i)?.forEach((v, c) => (values[p.fields[c].name] = v));
      out.push({ type: 'insert', values });
    }
    deleted.forEach((r) => r < baseCount && out.push({ type: 'delete', key: keyOf(r) }));
    return out;
  };

  const save = async () => {
    if (!page || !dirty) return;
    const changes = buildChanges();
    if (conn?.production) {
      const sql = await api.preview(tab.connectionId, tab.database, tab.schema, tab.table, changes, page.hiddenKey);
      if (!(await confirmDialog(`Enregistrer ${changes.length} modification(s) en production ?`, sql.slice(0, 12).join('\n') + (sql.length > 12 ? '\n…' : ''), { danger: true, confirmLabel: 'Enregistrer' })))
        return;
    }
    setSaving(true);
    try {
      const n = await api.apply(tab.connectionId, tab.database, tab.schema, tab.table, changes, page.hiddenKey);
      toast(`${fmtInt(n)} ligne(s) enregistrée(s)`, 'success');
      await load();
      api.count(tab.connectionId, tab.database, tab.schema, tab.table, where).then(setTotal).catch(() => {});
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const showPreview = async () => {
    try {
      setPreview(await api.preview(tab.connectionId, tab.database, tab.schema, tab.table, buildChanges(), page?.hiddenKey));
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const addRow = () => {
    setAdded((a) => a + 1);
    const firstCol = page ? Math.max(0, page.fields.findIndex((f, i) => !hidden.has(i) && !page.keyColumns.includes(f.name))) : 0;
    setTimeout(() => grid.current?.focusCell(baseCount + added, firstCol), 30);
  };

  const deleteSelected = () => {
    const target = new Set(selected);
    if (!target.size) {
      const sel = grid.current?.selection();
      if (sel) for (let r = sel.r0; r <= sel.r1; r++) target.add(r);
    }
    if (!target.size) return toast('Sélectionne des lignes (clic sur le numéro de ligne).');
    // les lignes ajoutées non enregistrées sont simplement retirées
    const addedTargets = [...target].filter((r) => r >= baseCount);
    if (addedTargets.length) {
      setEdits((prev) => {
        const next = new Map<number, Map<number, CellValue>>();
        let shift = 0;
        const sorted = [...prev.keys()].sort((a, b) => a - b);
        for (const r of sorted) {
          if (r >= baseCount && target.has(r)) continue;
          shift = r >= baseCount ? addedTargets.filter((x) => x < r).length : 0;
          next.set(r - shift, prev.get(r)!);
        }
        return next;
      });
      setAdded((a) => a - addedTargets.length);
    }
    setDeleted((prev) => {
      const next = new Set(prev);
      for (const r of target) if (r < baseCount) next.has(r) ? next.delete(r) : next.add(r);
      return next;
    });
    setSelected(new Set());
  };

  const onSort = (column: string, additive: boolean) =>
    guard(() => {
      setOrderBy((prev) => {
        const cur = prev.find((o) => o.column === column);
        const nextDir = !cur ? 'asc' : cur.dir === 'asc' ? 'desc' : null;
        const others = additive ? prev.filter((o) => o.column !== column) : [];
        return nextDir ? [...others, { column, dir: nextDir }] : others;
      });
      setOffset(0);
    });

  // raccourci Ctrl+S quand l'onglet est actif
  useEffect(() => {
    if (!active) return;
    const k = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });

  const editable = !!page?.editable;
  const modifiedCount = [...edits.keys()].filter((r) => r < baseCount && !deleted.has(r)).length;
  const lastPage = total !== null ? Math.max(0, Math.floor((total - 1) / limit)) : null;
  const pageNo = Math.floor(offset / limit);
  const q = conn ? qualified(conn.kind, tab.database, tab.schema, tab.table) : tab.table;

  return (
    <>
      <div className="filterbar">
        <Filter style={{ width: 14, height: 14, color: 'var(--muted)' }} />
        <span className="lbl">WHERE</span>
        <input
          className="input"
          value={whereInput}
          placeholder="ex. statut = 'active' AND cree_le > '2026-01-01'   (Entrée pour appliquer)"
          onChange={(e) => setWhereInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && guard(() => (setWhere(whereInput), setOffset(0)))}
          spellCheck={false}
        />
        {where && (
          <button className="btn icon" title="Retirer le filtre" onClick={() => guard(() => (setWhere(''), setWhereInput(''), setOffset(0)))}>
            <X />
          </button>
        )}
        {orderBy.length > 0 && (
          <button className="btn" title="Retirer le tri" onClick={() => guard(() => setOrderBy([]))}>
            ORDER BY {orderBy.map((o) => `${o.column} ${o.dir}`).join(', ')} <X />
          </button>
        )}
      </div>
      <div className="toolbar">
        <button className="btn" onClick={() => guard(load)} title="Actualiser">
          <RefreshCw className={loading ? 'spin' : ''} />
        </button>
        <span className="sep" />
        <button className="btn" disabled={!editable} onClick={addRow} title="Ajouter une ligne">
          <Plus /> Ligne
        </button>
        <button className="btn" disabled={!editable} onClick={deleteSelected} title="Marquer les lignes sélectionnées pour suppression">
          <Trash2 /> Supprimer
        </button>
        <span className="sep" />
        <button className={`btn ${dirty ? 'primary' : ''}`} disabled={!dirty || saving} onClick={save} title="Enregistrer (Ctrl+S)">
          <Save /> Enregistrer{dirty ? ` (${modifiedCount + added + deleted.size})` : ''}
        </button>
        <button className="btn" disabled={!dirty} onClick={showPreview} title="Voir le SQL qui sera exécuté">
          <Code2 /> Aperçu SQL
        </button>
        <button className="btn" disabled={!dirty} onClick={resetEdits} title="Annuler les modifications">
          <Undo2 /> Annuler
        </button>
        <span className="grow" />
        <button className="btn" onClick={() => newQueryTab(tab.connectionId, tab.database, page?.sql ?? `SELECT * FROM ${q}`)} title="Ouvrir cette requête dans l’éditeur">
          <FileCode />
        </button>
        <button className="btn" onClick={() => openExport({ connectionId: tab.connectionId, database: tab.database, schema: tab.schema, table: tab.table, where })} title="Exporter">
          <FileDown />
        </button>
      </div>
      {page && !page.editable && page.readOnlyReason && (
        <div className="banner info">
          <Info /> Lecture seule : {page.readOnlyReason}
        </div>
      )}
      {page?.hiddenKey && editable && (
        <div className="banner warn">
          <AlertTriangle /> Table sans clé primaire : les lignes sont identifiées par leur position physique (ctid). Recharge avant d’éditer si d’autres modifient la table.
        </div>
      )}
      {error && <div className="banner err">{error}</div>}
      {page ? (
        <DataGrid
          ref={grid}
          fields={page.fields}
          rows={rows}
          hidden={hidden}
          keyColumns={page.keyColumns}
          sort={orderBy}
          onSort={onSort}
          editable={editable}
          changed={(r, c) => !!edits.get(r)?.has(c) && r < baseCount}
          rowStatus={(r) => (r >= baseCount ? 'added' : deleted.has(r) ? 'deleted' : undefined)}
          onEdit={onEdit}
          selectedRows={selected}
          onSelectRows={setSelected}
          tableName={q}
          extraMenu={(r, c) =>
            page
              ? [
                  {
                    label: `Filtrer sur cette valeur`,
                    icon: <Filter />,
                    onClick: () => {
                      const f = page.fields[c].name;
                      const v = rows[r][c];
                      const quoted = conn?.kind === 'mysql' ? '`' + f + '`' : `"${f}"`;
                      const cond = v === null ? `${quoted} IS NULL` : `${quoted} = '${String(v).replace(/'/g, "''")}'`;
                      guard(() => {
                        setWhereInput(cond);
                        setWhere(cond);
                        setOffset(0);
                      });
                    },
                  },
                ]
              : []
          }
        />
      ) : (
        !error && <div className="empty-state">Chargement…</div>
      )}
      <div className="result-footer">
        <div className="pager">
          <button className="btn icon" disabled={offset === 0} onClick={() => guard(() => setOffset(0))} title="Première page">
            <ChevronsLeft />
          </button>
          <button className="btn icon" disabled={offset === 0} onClick={() => guard(() => setOffset(Math.max(0, offset - limit)))} title="Page précédente">
            <ChevronLeft />
          </button>
          <span>
            Page {pageNo + 1}
            {lastPage !== null ? ` / ${fmtInt(lastPage + 1)}` : ''}
          </span>
          <button
            className="btn icon"
            disabled={lastPage !== null ? pageNo >= lastPage : baseCount < limit}
            onClick={() => guard(() => setOffset(offset + limit))}
            title="Page suivante"
          >
            <ChevronRight />
          </button>
          <button className="btn icon" disabled={lastPage === null || pageNo >= lastPage} onClick={() => guard(() => setOffset((lastPage ?? 0) * limit))} title="Dernière page">
            <ChevronsRight />
          </button>
          <select className="input small" value={limit} onChange={(e) => guard(() => (setLimit(Number(e.target.value)), setOffset(0)))} aria-label="Lignes par page">
            {[50, 100, 200, 500, 1000, 5000].map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
        </div>
        <span>{total !== null ? `${fmtInt(total)} ligne(s)${where ? ' filtrées' : ''}` : 'Comptage…'}</span>
        {page && <span>{formatDuration(page.durationMs)}</span>}
        {dirty && (
          <span className="warn">
            {[
              modifiedCount ? `${modifiedCount} ligne(s) modifiée(s)` : '',
              added ? `${added} ajoutée(s)` : '',
              deleted.size ? `${deleted.size} à supprimer` : '',
            ]
              .filter(Boolean)
              .join(', ')}{' '}
            — non enregistré
          </span>
        )}
      </div>
      {preview && (
        <Modal
          title="SQL qui sera exécuté (dans une transaction)"
          wide
          onClose={() => setPreview(null)}
          footer={
            <>
              <button className="btn outline left" onClick={() => navigator.clipboard.writeText(preview.join('\n'))}>
                <Copy /> Copier
              </button>
              <button className="btn outline" onClick={() => setPreview(null)}>
                Fermer
              </button>
              <button
                className="btn primary"
                onClick={() => {
                  setPreview(null);
                  save();
                }}
              >
                Enregistrer
              </button>
            </>
          }
        >
          <pre className="sql-preview">{preview.join('\n')}</pre>
        </Modal>
      )}
    </>
  );
}

// ---------------- Structure ----------------
function StructureView({ tab }: { tab: TTab }) {
  const [st, setSt] = useState<TableStructure | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.structure(tab.connectionId, tab.database, tab.schema, tab.table).then(setSt).catch((e) => setError(e.message));
  }, [tab.connectionId, tab.database, tab.schema, tab.table]);
  if (error) return <div className="banner err">{error}</div>;
  if (!st) return <div className="empty-state">Chargement…</div>;
  return (
    <div className="page">
      {st.comment && <p className="lead">{st.comment}</p>}
      <h2>Colonnes ({st.columns.length})</h2>
      <table className="plain">
        <thead>
          <tr>
            <th>#</th>
            <th>Nom</th>
            <th>Type</th>
            <th>NULL</th>
            <th>Défaut</th>
            <th>Commentaire</th>
          </tr>
        </thead>
        <tbody>
          {st.columns.map((c) => (
            <tr key={c.name}>
              <td className="hint">{c.position}</td>
              <td className="mono">
                {c.name} {c.isPrimaryKey && <span className="pill pk">PK</span>}
                {c.autoIncrement && <span className="pill">auto</span>}
              </td>
              <td className="mono">{c.type}</td>
              <td>{c.nullable ? 'oui' : <b>NOT NULL</b>}</td>
              <td className="mono">{c.default ?? ''}</td>
              <td>{c.comment ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {st.indexes.length > 0 && (
        <>
          <h2>Index ({st.indexes.length})</h2>
          <table className="plain">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Colonnes</th>
                <th>Type</th>
                <th>Définition</th>
              </tr>
            </thead>
            <tbody>
              {st.indexes.map((i) => (
                <tr key={i.name}>
                  <td className="mono">{i.name}</td>
                  <td className="mono">{i.columns.join(', ')}</td>
                  <td>{i.primary ? <span className="pill pk">PRIMARY</span> : i.unique ? <span className="pill uq">UNIQUE</span> : <span className="pill">INDEX</span>}</td>
                  <td className="mono hint">{i.definition ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {st.foreignKeys.length > 0 && (
        <>
          <h2>Clés étrangères ({st.foreignKeys.length})</h2>
          <table className="plain">
            <thead>
              <tr>
                <th>Nom</th>
                <th>Colonnes</th>
                <th>Référence</th>
                <th>ON UPDATE</th>
                <th>ON DELETE</th>
              </tr>
            </thead>
            <tbody>
              {st.foreignKeys.map((f) => (
                <tr key={f.name}>
                  <td className="mono">{f.name}</td>
                  <td className="mono">{f.columns.join(', ')}</td>
                  <td className="mono">
                    <a
                      href="#"
                      style={{ color: 'var(--accent)' }}
                      onClick={(e) => {
                        e.preventDefault();
                        openTab({ id: uid(), kind: 'table', connectionId: tab.connectionId, database: tab.database, schema: f.refSchema, table: f.refTable, objType: 'table', view: 'data' });
                      }}
                    >
                      {f.refSchema !== tab.database && f.refSchema !== tab.schema ? f.refSchema + '.' : ''}
                      {f.refTable}
                    </a>
                    ({f.refColumns.join(', ')})
                  </td>
                  <td>{f.onUpdate}</td>
                  <td>{f.onDelete}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ---------------- DDL ----------------
function DdlView({ tab }: { tab: TTab }) {
  const settings = useApp((s) => s.settings);
  const dark = useApp((s) => s.themeDark);
  const conn = connectionById(tab.connectionId);
  const [ddl, setDdl] = useState<string>('-- Chargement…');
  useEffect(() => {
    api
      .ddl(tab.connectionId, tab.database, tab.schema, tab.table, tab.objType)
      .then(setDdl)
      .catch((e) => setDdl(`-- ${e.message}`));
  }, [tab.connectionId, tab.database, tab.schema, tab.table, tab.objType]);
  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={() => navigator.clipboard.writeText(ddl).then(() => toast('DDL copié'))}>
          <Copy /> Copier
        </button>
        <button className="btn" onClick={() => newQueryTab(tab.connectionId, tab.database, ddl, `DDL ${tab.table}`)}>
          <FileCode /> Ouvrir dans l’éditeur
        </button>
      </div>
      <SqlEditor value={ddl} onChange={() => {}} kind={conn?.kind ?? 'postgres'} fontSize={settings.editorFontSize} dark={dark} uppercase={settings.uppercaseKeywords} readOnly />
    </>
  );
}
