import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Braces, ClipboardCopy, Copy, KeyRound, Maximize2, Ban } from 'lucide-react';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { CellValue, ResultField } from '../../shared/types';
import { toast } from '../state';
import { Modal, openMenu, MenuItem } from './ui';

export type RowStatus = 'added' | 'deleted' | undefined;

export interface GridProps {
  fields: ResultField[];
  rows: CellValue[][];
  hidden?: Set<number>;
  keyColumns?: string[];
  sort?: { column: string; dir: 'asc' | 'desc' }[];
  onSort?: (column: string, additive: boolean) => void;
  editable?: boolean;
  changed?: (row: number, col: number) => boolean;
  rowStatus?: (row: number) => RowStatus;
  onEdit?: (row: number, col: number, value: CellValue) => void;
  selectedRows?: Set<number>;
  onSelectRows?: (rows: Set<number>) => void;
  extraMenu?: (row: number, col: number) => MenuItem[];
  tableName?: string;
}

export interface GridHandle {
  selection(): { r0: number; r1: number; c0: number; c1: number } | null;
  focusCell(r: number, c: number): void;
}

const NUMERIC = /^(int|int2|int4|int8|float4|float8|numeric|money|oid|tinyint|smallint|mediumint|bigint|decimal|float|double|year)$/i;
const CHAR_W = 7.3;

function display(v: CellValue): string {
  if (v === null) return 'NULL';
  const s = String(v);
  const short = s.length > 400 ? s.slice(0, 400) + '…' : s;
  return short.replace(/\r?\n/g, ' ↵ ');
}

function toTsv(v: CellValue) {
  if (v === null) return '';
  const s = String(v);
  return /[\t\n"]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export const DataGrid = forwardRef<GridHandle, GridProps>(function DataGrid(p, ref) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const visibleCols = useMemo(() => p.fields.map((_, i) => i).filter((i) => !p.hidden?.has(i)), [p.fields, p.hidden]);
  const [widths, setWidths] = useState<number[]>([]);
  const [anchor, setAnchor] = useState<{ r: number; c: number } | null>(null);
  const [focus, setFocus] = useState<{ r: number; c: number } | null>(null);
  const [editing, setEditing] = useState<{ r: number; c: number; value: string } | null>(null);
  const [viewer, setViewer] = useState<{ r: number; c: number; value: string; readOnly: boolean } | null>(null);
  const rnWidth = Math.max(44, String(p.rows.length).length * CHAR_W + 22);

  // Largeurs initiales estimées sur un échantillon
  const fieldsKey = p.fields.map((f) => f.name).join('\u0001');
  useEffect(() => {
    const sample = p.rows.slice(0, 120);
    setWidths(
      p.fields.map((f, i) => {
        let max = f.name.length + (f.type ? f.type.length * 0.8 : 0) + 4;
        for (const r of sample) max = Math.max(max, Math.min(display(r[i]).length, 48));
        return Math.round(Math.min(380, Math.max(70, max * CHAR_W + 18)));
      }),
    );
    setAnchor(null);
    setFocus(null);
    setEditing(null);
  }, [fieldsKey]);

  const virt = useVirtualizer({
    count: p.rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });

  const range = useMemo(() => {
    if (!anchor || !focus) return null;
    return {
      r0: Math.min(anchor.r, focus.r),
      r1: Math.max(anchor.r, focus.r),
      c0: Math.min(anchor.c, focus.c),
      c1: Math.max(anchor.c, focus.c),
    };
  }, [anchor, focus]);

  useImperativeHandle(ref, () => ({
    selection: () => range && { ...range, c0: visibleCols[range.c0], c1: visibleCols[range.c1] },
    focusCell: (r, c) => {
      const vc = Math.max(0, visibleCols.indexOf(c));
      setAnchor({ r, c: vc });
      setFocus({ r, c: vc });
      virt.scrollToIndex(r);
      scrollRef.current?.focus();
    },
  }));

  const isNumeric = (i: number) => NUMERIC.test(p.fields[i]?.type ?? '');
  const canEdit = (r: number) => p.editable && p.rowStatus?.(r) !== 'deleted';

  const startEdit = (r: number, vc: number) => {
    if (!canEdit(r)) return;
    const c = visibleCols[vc];
    const v = p.rows[r][c];
    const s = v === null ? '' : String(v);
    if (s.includes('\n') || s.length > 300) setViewer({ r, c, value: s, readOnly: false });
    else setEditing({ r, c, value: s });
  };

  const commitEdit = (value: CellValue) => {
    if (!editing) return;
    const old = p.rows[editing.r][editing.c];
    if (String(old ?? '') !== String(value ?? '') || (old === null) !== (value === null)) p.onEdit?.(editing.r, editing.c, value);
    setEditing(null);
    scrollRef.current?.focus();
  };

  const copy = (withHeaders = false) => {
    if (!range) return;
    const cols = visibleCols.slice(range.c0, range.c1 + 1);
    const lines: string[] = [];
    if (withHeaders) lines.push(cols.map((c) => p.fields[c].name).join('\t'));
    for (let r = range.r0; r <= range.r1; r++) lines.push(cols.map((c) => toTsv(p.rows[r][c])).join('\t'));
    navigator.clipboard.writeText(lines.join('\n'));
    const n = (range.r1 - range.r0 + 1) * cols.length;
    if (n > 1) toast(`${n} cellules copiées`);
  };

  const copyAsInsert = () => {
    if (!range) return;
    const cols = visibleCols;
    const lit = (v: CellValue) => (v === null ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
    const lines = [];
    for (let r = range.r0; r <= range.r1; r++)
      lines.push(`INSERT INTO ${p.tableName ?? 'table'} (${cols.map((c) => p.fields[c].name).join(', ')}) VALUES (${cols.map((c) => lit(p.rows[r][c])).join(', ')});`);
    navigator.clipboard.writeText(lines.join('\n'));
    toast(`${lines.length} INSERT copiés`);
  };

  const move = (dr: number, dc: number, extend: boolean) => {
    const cur = focus ?? { r: 0, c: 0 };
    const next = {
      r: Math.max(0, Math.min(p.rows.length - 1, cur.r + dr)),
      c: Math.max(0, Math.min(visibleCols.length - 1, cur.c + dc)),
    };
    setFocus(next);
    if (!extend) setAnchor(next);
    virt.scrollToIndex(next.r);
    // défilement horizontal
    const el = scrollRef.current;
    if (el) {
      let x = rnWidth;
      for (let i = 0; i < next.c; i++) x += widths[visibleCols[i]] ?? 100;
      const w = widths[visibleCols[next.c]] ?? 100;
      if (x < el.scrollLeft + rnWidth) el.scrollLeft = x - rnWidth;
      else if (x + w > el.scrollLeft + el.clientWidth) el.scrollLeft = x + w - el.clientWidth;
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (editing || !p.rows.length) return;
    const mod = e.ctrlKey || e.metaKey;
    const page = Math.max(1, Math.floor((scrollRef.current?.clientHeight ?? 300) / 26) - 2);
    switch (e.key) {
      case 'ArrowDown': move(1, 0, e.shiftKey); break;
      case 'ArrowUp': move(-1, 0, e.shiftKey); break;
      case 'ArrowRight': move(0, 1, e.shiftKey); break;
      case 'ArrowLeft': move(0, -1, e.shiftKey); break;
      case 'PageDown': move(page, 0, e.shiftKey); break;
      case 'PageUp': move(-page, 0, e.shiftKey); break;
      case 'Home': move(mod ? -1e9 : 0, mod ? -1e9 : -1e9, e.shiftKey); break;
      case 'End': move(mod ? 1e9 : 0, 1e9, e.shiftKey); break;
      case 'Tab': move(0, e.shiftKey ? -1 : 1, false); break;
      case 'Enter':
      case 'F2':
        if (focus) startEdit(focus.r, focus.c);
        break;
      case 'Delete':
        if (focus && canEdit(focus.r) && e.shiftKey === false && mod) p.onEdit?.(focus.r, visibleCols[focus.c], null);
        else return;
        break;
      case 'c':
      case 'C':
        if (!mod) return;
        copy(e.shiftKey);
        break;
      case 'a':
      case 'A':
        if (!mod) return;
        setAnchor({ r: 0, c: 0 });
        setFocus({ r: p.rows.length - 1, c: visibleCols.length - 1 });
        break;
      default:
        if (e.key.length === 1 && !mod && !e.altKey && focus && canEdit(focus.r)) {
          setEditing({ r: focus.r, c: visibleCols[focus.c], value: e.key });
          e.preventDefault();
        }
        return;
    }
    e.preventDefault();
  };

  const rowClick = (r: number, e: React.MouseEvent) => {
    if (!p.onSelectRows) return;
    const next = new Set(e.ctrlKey || e.metaKey ? p.selectedRows : []);
    if (e.shiftKey && p.selectedRows?.size) {
      const last = [...p.selectedRows].pop()!;
      for (let i = Math.min(last, r); i <= Math.max(last, r); i++) next.add(i);
    } else if (next.has(r)) next.delete(r);
    else next.add(r);
    p.onSelectRows(next);
    setAnchor({ r, c: 0 });
    setFocus({ r, c: visibleCols.length - 1 });
  };

  const cellMenu = (e: React.MouseEvent, r: number, vc: number) => {
    const c = visibleCols[vc];
    if (!range || r < range.r0 || r > range.r1 || vc < range.c0 || vc > range.c1) {
      setAnchor({ r, c: vc });
      setFocus({ r, c: vc });
    }
    const v = p.rows[r][c];
    const items: MenuItem[] = [
      { label: 'Copier', icon: <Copy />, onClick: () => setTimeout(() => copy(false)) },
      { label: 'Copier avec les en-têtes', icon: <ClipboardCopy />, onClick: () => setTimeout(() => copy(true)) },
      { label: 'Copier en INSERT', icon: <ClipboardCopy />, onClick: () => setTimeout(copyAsInsert) },
      { label: 'Afficher la valeur', icon: <Maximize2 />, onClick: () => setViewer({ r, c, value: v === null ? '' : String(v), readOnly: !canEdit(r) }) },
    ];
    if (canEdit(r))
      items.push({ separator: true }, { label: 'Mettre à NULL', icon: <Ban />, onClick: () => p.onEdit?.(r, c, null) });
    items.push(...(p.extraMenu?.(r, c) ?? []));
    openMenu(e, items);
  };

  const totalWidth = rnWidth + visibleCols.reduce((a, c) => a + (widths[c] ?? 100), 0);

  const resize = (c: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = e.clientX;
    const w0 = widths[c] ?? 100;
    const mv = (ev: MouseEvent) => setWidths((ws) => ws.map((w, i) => (i === c ? Math.max(40, w0 + ev.clientX - start) : w)));
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  if (!p.fields.length) return <div className="empty-state"><div className="inner">Aucune colonne.</div></div>;

  return (
    <>
      <div className="grid" ref={scrollRef} tabIndex={0} onKeyDown={onKey} role="grid" aria-rowcount={p.rows.length}>
        <div className="grid-head" style={{ width: totalWidth }}>
          <div className="gh rn" style={{ width: rnWidth }} title={`${p.rows.length} lignes`} />
          {visibleCols.map((c) => {
            const f = p.fields[c];
            const s = p.sort?.find((x) => x.column === f.name);
            return (
              <div
                key={c}
                className="gh"
                style={{ width: widths[c] ?? 100 }}
                title={`${f.name}${f.type ? ` : ${f.type}` : ''}${p.onSort ? '\nClic : trier · Maj+clic : tri secondaire' : ''}`}
                onClick={(e) => p.onSort?.(f.name, e.shiftKey)}
              >
                {p.keyColumns?.includes(f.name) && <KeyRound className="key" />}
                <span className="nm">{f.name}</span>
                {f.type && <span className="ty">{f.type}</span>}
                {s && (s.dir === 'asc' ? <ArrowUp className="sort" /> : <ArrowDown className="sort" />)}
                <span className="resize" onMouseDown={resize(c)} onClick={(e) => e.stopPropagation()} />
              </div>
            );
          })}
        </div>
        <div className="grid-body" style={{ height: virt.getTotalSize(), width: totalWidth }}>
          {virt.getVirtualItems().map((vr) => {
            const r = vr.index;
            const row = p.rows[r];
            const st = p.rowStatus?.(r);
            return (
              <div key={r} className={`gr ${st ?? ''} ${p.selectedRows?.has(r) ? 'rowsel' : ''}`} style={{ top: vr.start, width: totalWidth }}>
                <div className="gc rn" style={{ width: rnWidth }} onMouseDown={(e) => rowClick(r, e)}>
                  {st === 'added' ? '+' : r + 1}
                </div>
                {visibleCols.map((c, vc) => {
                  const v = row[c];
                  const inRange = range && r >= range.r0 && r <= range.r1 && vc >= range.c0 && vc <= range.c1;
                  const isFocus = focus && focus.r === r && focus.c === vc;
                  const cls = [
                    'gc',
                    v === null ? 'null' : '',
                    isNumeric(c) || typeof v === 'number' ? 'num' : '',
                    p.changed?.(r, c) ? 'changed' : '',
                    isFocus ? 'sel' : inRange ? 'range' : '',
                  ].join(' ');
                  if (editing && editing.r === r && editing.c === c)
                    return (
                      <div key={c} className="gc" style={{ width: widths[c] ?? 100, padding: '2px' }}>
                        <input
                          className="cell-edit"
                          autoFocus
                          value={editing.value}
                          onChange={(e) => setEditing({ ...editing, value: e.target.value })}
                          onBlur={() => commitEdit(editing.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') commitEdit(editing.value);
                            if (e.key === 'Escape') {
                              setEditing(null);
                              scrollRef.current?.focus();
                            }
                            if (e.key === 'Tab') {
                              e.preventDefault();
                              commitEdit(editing.value);
                              move(0, e.shiftKey ? -1 : 1, false);
                            }
                            e.stopPropagation();
                          }}
                        />
                      </div>
                    );
                  return (
                    <div
                      key={c}
                      className={cls}
                      style={{ width: widths[c] ?? 100 }}
                      onMouseDown={(e) => {
                        if (e.button !== 0) return;
                        if (e.shiftKey && anchor) setFocus({ r, c: vc });
                        else {
                          setAnchor({ r, c: vc });
                          setFocus({ r, c: vc });
                        }
                      }}
                      onMouseEnter={(e) => e.buttons === 1 && anchor && setFocus({ r, c: vc })}
                      onDoubleClick={() => (canEdit(r) ? startEdit(r, vc) : setViewer({ r, c, value: v === null ? '' : String(v), readOnly: true }))}
                      onContextMenu={(e) => cellMenu(e, r, vc)}
                    >
                      {display(v)}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {viewer && (
        <ValueViewer
          title={p.fields[viewer.c]?.name ?? ''}
          value={viewer.value}
          readOnly={viewer.readOnly}
          onClose={() => setViewer(null)}
          onSave={(v) => {
            p.onEdit?.(viewer.r, viewer.c, v);
            setViewer(null);
          }}
        />
      )}
    </>
  );
});

function ValueViewer(props: { title: string; value: string; readOnly: boolean; onClose: () => void; onSave: (v: CellValue) => void }) {
  const [text, setText] = useState(props.value);
  const isJson = /^\s*[[{]/.test(text);
  return (
    <Modal
      title={`Valeur : ${props.title}`}
      onClose={props.onClose}
      wide
      footer={
        <>
          {isJson && (
            <button
              className="btn outline left"
              onClick={() => {
                try {
                  setText(JSON.stringify(JSON.parse(text), null, 2));
                } catch {
                  toast('JSON invalide', 'error');
                }
              }}
            >
              <Braces /> Formater le JSON
            </button>
          )}
          <span className="hint" style={{ marginRight: 'auto', marginLeft: isJson ? 0 : undefined }}>
            {text.length.toLocaleString('fr-FR')} caractères
          </span>
          <button className="btn outline" onClick={() => navigator.clipboard.writeText(text)}>
            <Copy /> Copier
          </button>
          {!props.readOnly && (
            <>
              <button className="btn outline" onClick={() => props.onSave(null)}>
                Mettre à NULL
              </button>
              <button className="btn primary" onClick={() => props.onSave(text)}>
                Appliquer
              </button>
            </>
          )}
        </>
      }
    >
      <textarea
        className="input mono"
        style={{ width: '100%', height: '50vh', fontSize: 12.5 }}
        value={text}
        readOnly={props.readOnly}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
      />
    </Modal>
  );
}
