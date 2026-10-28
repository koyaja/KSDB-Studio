import dagre from '@dagrejs/dagre';
import {
  Download,
  Eye,
  EyeOff,
  FileCode,
  KeyRound,
  Layers,
  LayoutGrid,
  Link2,
  Maximize,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Table2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ErdModel, ErdRelation, ErdTable } from '../../shared/types';
import { qualified } from '../actions';
import { api } from '../api';
import { fmtInt, openMenu } from '../components/ui';
import { connectionById, newQueryTab, openTab, Tab, toast, uid, useApp } from '../state';

type ETab = Extract<Tab, { kind: 'erd' }>;
type Mode = 'all' | 'keys' | 'name';
type Pos = Record<string, { x: number; y: number }>;

const HEADER_H = 30;
const ROW_H = 21;
const BOTTOM_PAD = 6;
const CH = 7.2; // largeur approximative d'un caractère (12 px mono)

interface Box {
  t: ErdTable;
  cols: ErdTable['columns'];
  w: number;
  h: number;
}

function boxFor(t: ErdTable, mode: Mode): Box {
  const cols = mode === 'all' ? t.columns : mode === 'keys' ? t.columns.filter((c) => c.pk || c.fk) : [];
  const nameW = t.name.length * 7.6 + 40;
  let colW = 0;
  for (const c of cols) colW = Math.max(colW, 32 + (c.name.length + 2) * CH + 22 + Math.min(c.type.length, 22) * 6.6 + 12);
  const w = Math.round(Math.min(380, Math.max(170, nameW, colW)));
  const h = HEADER_H + cols.length * ROW_H + (cols.length ? BOTTOM_PAD : 0);
  return { t, cols, w, h };
}

/** Mise en page automatique : dagre pour les tables reliées, grille pour les tables isolées. */
function autoLayout(boxes: Map<string, Box>, rels: ErdRelation[]): Pos {
  const linked = new Set<string>();
  for (const r of rels) if (boxes.has(r.from) && boxes.has(r.to) && r.from !== r.to) linked.add(r.from).add(r.to);
  const pos: Pos = {};
  let maxX = 0;
  let maxY = 0;
  if (linked.size) {
    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: 'LR', nodesep: 34, ranksep: 110, marginx: 40, marginy: 40 });
    g.setDefaultEdgeLabel(() => ({}));
    for (const n of linked) {
      const b = boxes.get(n)!;
      g.setNode(n, { width: b.w, height: b.h });
    }
    for (const r of rels) if (linked.has(r.from) && linked.has(r.to) && r.from !== r.to) g.setEdge(r.to, r.from, {}, r.name);
    dagre.layout(g);
    for (const n of linked) {
      const nd = g.node(n);
      const b = boxes.get(n)!;
      pos[n] = { x: Math.round(nd.x - b.w / 2), y: Math.round(nd.y - b.h / 2) };
      maxX = Math.max(maxX, pos[n].x + b.w);
      maxY = Math.max(maxY, pos[n].y + b.h);
    }
  }
  // tables sans relation : grille sous le graphe
  const lone = [...boxes.keys()].filter((n) => !linked.has(n));
  if (lone.length) {
    const width = Math.max(maxX, 1200);
    let x = 40;
    let y = linked.size ? maxY + 80 : 40;
    let rowH = 0;
    for (const n of lone) {
      const b = boxes.get(n)!;
      if (x + b.w > width && x > 40) {
        x = 40;
        y += rowH + 36;
        rowH = 0;
      }
      pos[n] = { x, y };
      x += b.w + 36;
      rowH = Math.max(rowH, b.h);
    }
  }
  return pos;
}

function colY(b: Box, col: string): number {
  const i = b.cols.findIndex((c) => c.name === col);
  return i < 0 ? HEADER_H / 2 : HEADER_H + i * ROW_H + ROW_H / 2;
}

interface Edge {
  r: ErdRelation;
  d: string;
  /** position du pied de corbeau (côté « plusieurs ») */
  many: { x: number; y: number; dir: 1 | -1 };
  one: { x: number; y: number; dir: 1 | -1 };
}

function routeEdge(r: ErdRelation, a: Box, pa: { x: number; y: number }, b: Box, pb: { x: number; y: number }): Edge {
  const ya = pa.y + colY(a, r.fromColumns[0]);
  const yb = pb.y + colY(b, r.toColumns[0]);
  if (r.from === r.to) {
    const x = pa.x + a.w;
    const d = `M ${x} ${ya} C ${x + 60} ${ya}, ${x + 60} ${yb}, ${x} ${yb}`;
    return { r, d, many: { x, y: ya, dir: 1 }, one: { x, y: yb, dir: 1 } };
  }
  const aC = pa.x + a.w / 2;
  const bC = pb.x + b.w / 2;
  let xa: number, xb: number, da: 1 | -1, db: 1 | -1;
  if (pa.x > pb.x + b.w + 20) [xa, da, xb, db] = [pa.x, -1, pb.x + b.w, 1];
  else if (pb.x > pa.x + a.w + 20) [xa, da, xb, db] = [pa.x + a.w, 1, pb.x, -1];
  else if (aC >= bC) [xa, da, xb, db] = [pa.x + a.w, 1, pb.x + b.w, 1];
  else [xa, da, xb, db] = [pa.x, -1, pb.x, -1];
  const k = Math.max(50, Math.min(140, Math.abs(xb - xa) / 2));
  const d = `M ${xa} ${ya} C ${xa + da * k} ${ya}, ${xb + db * k} ${yb}, ${xb} ${yb}`;
  return { r, d, many: { x: xa, y: ya, dir: da }, one: { x: xb, y: yb, dir: db } };
}

export function ErdTab({ tab, active }: { tab: ETab; active: boolean }) {
  const conn = useApp((s) => s.connections.find((c) => c.id === tab.connectionId));
  const themeKey = useApp((s) => s.themeResolved);
  const [model, setModel] = useState<ErdModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<Mode>('all');
  const [showViews, setShowViews] = useState(false);
  const [pos, setPos] = useState<Pos>({});
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [selected, setSelected] = useState<string | null>(null);
  const [hoverRel, setHoverRel] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const host = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const layoutKey = `${tab.connectionId}|${tab.database}|${tab.schema}`;
  const fitted = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [m, saved] = await Promise.all([
        api.erd(tab.connectionId, tab.database, tab.schema),
        api.erdLayout(layoutKey).catch(() => null) as Promise<{ pos?: Pos; mode?: Mode; showViews?: boolean } | null>,
      ]);
      setModel(m);
      if (saved?.mode) setMode(saved.mode);
      if (saved?.showViews !== undefined) setShowViews(saved.showViews);
      setPos(saved?.pos ?? {});
      fitted.current = false;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [tab.connectionId, tab.database, tab.schema]);

  useEffect(() => {
    load();
  }, [load]);

  const tables = useMemo(() => (model ? model.tables.filter((t) => showViews || t.kind === 'table') : []), [model, showViews]);
  const boxes = useMemo(() => new Map(tables.map((t) => [t.name, boxFor(t, mode)])), [tables, mode]);
  const rels = useMemo(() => (model ? model.relations.filter((r) => r.toSchema === model.schema && boxes.has(r.from) && boxes.has(r.to)) : []), [model, boxes]);
  const external = useMemo(() => (model ? model.relations.filter((r) => r.toSchema !== model.schema) : []), [model]);

  // positions : sauvegardées sinon calculées
  const layout = useMemo(() => {
    const missing = [...boxes.keys()].filter((n) => !pos[n]);
    if (!missing.length) return pos;
    if (missing.length === boxes.size) return autoLayout(boxes, rels);
    // nouvelles tables : à droite du diagramme existant
    let maxX = 0;
    for (const [n, p] of Object.entries(pos)) if (boxes.has(n)) maxX = Math.max(maxX, p.x + boxes.get(n)!.w);
    const out = { ...pos };
    let y = 40;
    for (const n of missing) {
      out[n] = { x: maxX + 80, y };
      y += boxes.get(n)!.h + 30;
    }
    return out;
  }, [boxes, rels, pos]);

  const persist = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = (p: Pos, m = mode, v = showViews) => {
    if (persist.current) clearTimeout(persist.current);
    persist.current = setTimeout(() => api.saveErdLayout(layoutKey, { pos: p, mode: m, showViews: v }).catch(() => {}), 500);
  };

  const bounds = useMemo(() => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [n, b] of boxes) {
      const p = layout[n];
      if (!p) continue;
      x0 = Math.min(x0, p.x);
      y0 = Math.min(y0, p.y);
      x1 = Math.max(x1, p.x + b.w + 70);
      y1 = Math.max(y1, p.y + b.h);
    }
    return Number.isFinite(x0) ? { x0: x0 - 30, y0: y0 - 30, x1: x1 + 30, y1: y1 + 30 } : { x0: 0, y0: 0, x1: 800, y1: 600 };
  }, [boxes, layout]);

  const fit = useCallback(() => {
    const el = host.current;
    if (!el) return;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const k = Math.min(1.2, Math.max(0.15, Math.min(w / (bounds.x1 - bounds.x0), h / (bounds.y1 - bounds.y0))));
    setView({ k, x: (w - (bounds.x1 - bounds.x0) * k) / 2 - bounds.x0 * k, y: (h - (bounds.y1 - bounds.y0) * k) / 2 - bounds.y0 * k });
  }, [bounds]);

  useEffect(() => {
    if (active && model && !fitted.current && host.current?.clientWidth) {
      fitted.current = true;
      fit();
    }
  }, [active, model, fit]);

  const edges = useMemo(
    () => rels.map((r) => routeEdge(r, boxes.get(r.from)!, layout[r.from], boxes.get(r.to)!, layout[r.to])),
    [rels, boxes, layout],
  );

  const neighbours = useMemo(() => {
    if (!selected) return null;
    const s = new Set([selected]);
    for (const r of rels) {
      if (r.from === selected) s.add(r.to);
      if (r.to === selected) s.add(r.from);
    }
    return s;
  }, [selected, rels]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(tables.filter((t) => t.name.toLowerCase().includes(q) || t.columns.some((c) => c.name.toLowerCase().includes(q))).map((t) => t.name));
  }, [query, tables]);

  // ---------- interactions ----------
  const zoomAt = (factor: number, cx: number, cy: number) =>
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.1, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });

  const onWheel = (e: React.WheelEvent) => {
    const r = host.current!.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > 0) {
      if (e.shiftKey) setView((v) => ({ ...v, x: v.x - e.deltaY }));
      else zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }
  };

  const onBgDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const v0 = view;
    let moved = false;
    const mv = (ev: MouseEvent) => {
      moved = moved || Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3;
      setView({ ...v0, x: v0.x + ev.clientX - sx, y: v0.y + ev.clientY - sy });
    };
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      if (!moved) setSelected(null);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  const onTableDown = (name: string) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const p0 = layout[name];
    const k = view.k;
    let cur = layout;
    let moved = false;
    const mv = (ev: MouseEvent) => {
      const dx = (ev.clientX - sx) / k;
      const dy = (ev.clientY - sy) / k;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
      moved = true;
      cur = { ...layout, [name]: { x: Math.round(p0.x + dx), y: Math.round(p0.y + dy) } };
      setPos(cur);
    };
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
      if (moved) save(cur);
      else setSelected((s) => (s === name ? null : name));
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  const center = (name: string) => {
    const p = layout[name];
    const b = boxes.get(name);
    const el = host.current;
    if (!p || !b || !el) return;
    const k = Math.max(view.k, 0.8);
    setView({ k, x: el.clientWidth / 2 - (p.x + b.w / 2) * k, y: el.clientHeight / 2 - (p.y + b.h / 2) * k });
    setSelected(name);
  };

  const openData = (name: string, kind: ErdTable['kind']) =>
    openTab({ id: uid(), kind: 'table', connectionId: tab.connectionId, database: tab.database, schema: tab.schema, table: name, objType: kind === 'view' ? 'view' : 'table', view: 'data' });

  const tableMenu = (t: ErdTable) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const q = conn ? qualified(conn.kind, tab.database, tab.schema, t.name) : t.name;
    openMenu(e, [
      { label: 'Ouvrir les données', icon: <Table2 />, onClick: () => openData(t.name, t.kind) },
      { label: 'Structure', icon: <Layers />, onClick: () => openTab({ id: uid(), kind: 'table', connectionId: tab.connectionId, database: tab.database, schema: tab.schema, table: t.name, objType: t.kind === 'view' ? 'view' : 'table', view: 'structure' }) },
      ...(t.kind === 'table'
        ? [{ label: 'Modifier la structure', icon: <Pencil />, onClick: () => openTab({ id: uid(), kind: 'designer', connectionId: tab.connectionId, database: tab.database, schema: tab.schema, table: t.name }) }]
        : []),
      {
        label: 'Requête avec jointures',
        icon: <FileCode />,
        onClick: () => newQueryTab(tab.connectionId, tab.database, joinQuery(t, rels, (n) => (conn ? qualified(conn.kind, tab.database, tab.schema, n) : n), conn?.kind === 'mysql' ? '`' : '"'), `Jointures ${t.name}`),
      },
      { separator: true },
      { label: 'Centrer', icon: <Maximize />, onClick: () => center(t.name) },
      { label: 'Copier le nom qualifié', onClick: () => navigator.clipboard.writeText(q) },
    ]);
  };

  // ---------- export ----------
  const exportAs = async (fmt: 'svg' | 'png') => {
    const svg = svgRef.current;
    if (!svg) return;
    const file = await api.saveDialog({
      title: 'Exporter le diagramme',
      defaultPath: `erd_${tab.database}${tab.schema !== tab.database ? '_' + tab.schema : ''}.${fmt}`,
      filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }],
    });
    if (!file) return;
    const text = serializeSvg(svg, bounds);
    try {
      if (fmt === 'svg') await api.writeText(file, text);
      else {
        const scale = 2;
        const w = (bounds.x1 - bounds.x0) * scale;
        const h = (bounds.y1 - bounds.y0) * scale;
        if (w * h > 16000 * 16000 / 2) throw new Error('Diagramme trop grand pour un PNG : exporte en SVG.');
        const img = new Image();
        img.src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
        await api.writeBase64(file, canvas.toDataURL('image/png').split(',')[1]);
      }
      toast(`Diagramme exporté : ${file.split(/[\\/]/).pop()}`, 'success');
      api.showItem(file).catch(() => {});
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };

  const dimmedTable = (n: string) => (neighbours ? !neighbours.has(n) : matches ? !matches.has(n) : false);
  const activeRel = (r: ErdRelation) => hoverRel === r.name + r.from || (selected !== null && (r.from === selected || r.to === selected));

  return (
    <div className={`pane ${active ? '' : 'hidden'}`}>
      <div className="toolbar">
        <button className="btn" onClick={load} title="Recharger le schéma">
          <RefreshCw className={loading ? 'spin' : ''} />
        </button>
        <button
          className="btn"
          title="Recalculer la disposition automatique"
          onClick={() => {
            const p = autoLayout(boxes, rels);
            setPos(p);
            save(p);
            setTimeout(() => {
              fitted.current = false;
              fit();
            }, 30);
          }}
        >
          <LayoutGrid /> Réorganiser
        </button>
        <span className="sep" />
        <div className="subtabs" role="radiogroup" aria-label="Colonnes affichées">
          {(
            [
              ['all', 'Toutes les colonnes'],
              ['keys', 'Clés'],
              ['name', 'Noms'],
            ] as const
          ).map(([k, l]) => (
            <button
              key={k}
              className={mode === k ? 'active' : ''}
              onClick={() => {
                setMode(k);
                save(layout, k);
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <button
          className={`btn ${showViews ? 'on' : ''}`}
          onClick={() => {
            setShowViews(!showViews);
            save(layout, mode, !showViews);
          }}
          title="Afficher les vues"
        >
          {showViews ? <Eye /> : <EyeOff />} Vues
        </button>
        <span className="sep" />
        <div style={{ position: 'relative' }}>
          <input
            className="input small"
            style={{ width: 220, paddingLeft: 26 }}
            placeholder="Chercher une table ou colonne"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches?.size) center([...matches][0]);
              if (e.key === 'Escape') setQuery('');
            }}
          />
          <Search style={{ position: 'absolute', left: 8, top: 6, width: 13, height: 13, color: 'var(--muted)' }} />
        </div>
        <span className="grow" />
        <button className="btn icon" title="Zoom arrière" onClick={() => zoomAt(1 / 1.2, (host.current?.clientWidth ?? 0) / 2, (host.current?.clientHeight ?? 0) / 2)}>
          <Minus />
        </button>
        <span className="hint" style={{ width: 42, textAlign: 'center' }}>
          {Math.round(view.k * 100)} %
        </span>
        <button className="btn icon" title="Zoom avant" onClick={() => zoomAt(1.2, (host.current?.clientWidth ?? 0) / 2, (host.current?.clientHeight ?? 0) / 2)}>
          <Plus />
        </button>
        <button className="btn icon" title="Tout afficher" onClick={fit}>
          <Maximize />
        </button>
        <span className="sep" />
        <button
          className="btn"
          onClick={(e) =>
            openMenu(e, [
              { label: 'Image PNG', icon: <Download />, onClick: () => exportAs('png') },
              { label: 'Image vectorielle SVG', icon: <Download />, onClick: () => exportAs('svg') },
            ])
          }
        >
          <Download /> Exporter
        </button>
      </div>
      {error && <div className="banner err">{error}</div>}
      <div className="erd-host" ref={host} onWheel={onWheel} onMouseDown={onBgDown} data-theme-key={themeKey}>
        {model && !tables.length && (
          <div className="empty-state" style={{ position: 'absolute', inset: 0 }}>
            <div className="inner">Aucune table dans « {model.schema} ».</div>
          </div>
        )}
        <svg ref={svgRef} className="erd-svg" width="100%" height="100%">
          <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
            <g className="erd-edges">
              {edges.map((e) => {
                const on = activeRel(e.r);
                const dim = (neighbours && !on) || (matches && !(matches.has(e.r.from) || matches.has(e.r.to)));
                return (
                  <g
                    key={e.r.from + e.r.name}
                    opacity={dim ? 0.15 : 1}
                    onMouseEnter={() => setHoverRel(e.r.name + e.r.from)}
                    onMouseLeave={() => setHoverRel(null)}
                  >
                    <title>{`${e.r.name}\n${e.r.from}(${e.r.fromColumns.join(', ')}) → ${e.r.to}(${e.r.toColumns.join(', ')})\nON DELETE ${e.r.onDelete}`}</title>
                    <path d={e.d} fill="none" stroke="transparent" strokeWidth={12} />
                    <path d={e.d} fill="none" stroke={on ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth={on ? 2 : 1.4} />
                    <CrowFoot x={e.many.x} y={e.many.y} dir={e.many.dir} color={on ? 'var(--accent)' : 'var(--line-strong)'} />
                    <OneMark x={e.one.x} y={e.one.y} dir={e.one.dir} color={on ? 'var(--accent)' : 'var(--line-strong)'} />
                  </g>
                );
              })}
            </g>
            {tables.map((t) => {
              const b = boxes.get(t.name)!;
              const p = layout[t.name];
              if (!p) return null;
              const sel = selected === t.name;
              const hit = matches?.has(t.name);
              return (
                <g
                  key={t.name}
                  transform={`translate(${p.x} ${p.y})`}
                  opacity={dimmedTable(t.name) ? 0.28 : 1}
                  onMouseDown={onTableDown(t.name)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    openData(t.name, t.kind);
                  }}
                  onContextMenu={tableMenu(t)}
                  className="erd-table"
                >
                  <rect
                    width={b.w}
                    height={b.h}
                    rx={6}
                    fill="var(--panel)"
                    stroke={sel || hit ? 'var(--accent)' : 'var(--line-strong)'}
                    strokeWidth={sel || hit ? 2 : 1}
                  />
                  <path
                    d={`M0 6 a6 6 0 0 1 6 -6 h${b.w - 12} a6 6 0 0 1 6 6 v${HEADER_H - 6} h-${b.w} z`}
                    fill={t.kind === 'view' ? 'var(--ok-soft)' : 'var(--accent-soft)'}
                  />
                  <text x={12} y={19} fill="var(--text)" fontSize={12.5} fontWeight={600} fontFamily="IBM Plex Sans, Segoe UI, sans-serif">
                    {t.name}
                  </text>
                  {t.rows !== null && t.kind === 'table' && (
                    <text x={b.w - 10} y={19} fill="var(--muted)" fontSize={10.5} textAnchor="end" fontFamily="IBM Plex Sans, Segoe UI, sans-serif">
                      {fmtRows(t.rows)}
                    </text>
                  )}
                  {t.kind === 'view' && (
                    <text x={b.w - 10} y={19} fill="var(--ok)" fontSize={10.5} textAnchor="end" fontFamily="IBM Plex Sans, Segoe UI, sans-serif">
                      vue
                    </text>
                  )}
                  {b.cols.length > 0 && <line x1={0} x2={b.w} y1={HEADER_H} y2={HEADER_H} stroke="var(--line)" />}
                  {b.cols.map((c, i) => {
                    const y = HEADER_H + i * ROW_H;
                    const colHit = matches && query.trim() && c.name.toLowerCase().includes(query.trim().toLowerCase());
                    return (
                      <g key={c.name} transform={`translate(0 ${y})`}>
                        {colHit && <rect x={1} width={b.w - 2} height={ROW_H} fill="var(--accent-soft)" />}
                        {c.pk ? (
                          <text x={10} y={15} fill="var(--ochre)" fontSize={10} fontWeight={700} fontFamily="JetBrains Mono, Consolas, monospace">
                            PK
                          </text>
                        ) : c.fk ? (
                          <text x={10} y={15} fill="var(--accent)" fontSize={10} fontWeight={700} fontFamily="JetBrains Mono, Consolas, monospace">
                            FK
                          </text>
                        ) : null}
                        <text
                          x={32}
                          y={15}
                          fill={c.pk || c.fk ? 'var(--text)' : 'var(--text-2)'}
                          fontSize={12}
                          fontWeight={c.pk ? 600 : 400}
                          fontFamily="JetBrains Mono, Consolas, monospace"
                        >
                          {c.name}
                          {!c.nullable && !c.pk ? ' *' : ''}
                        </text>
                        <text x={b.w - 10} y={15} fill="var(--muted)" fontSize={11} textAnchor="end" fontFamily="JetBrains Mono, Consolas, monospace">
                          {c.type.length > 22 ? c.type.slice(0, 21) + '…' : c.type}
                        </text>
                      </g>
                    );
                  })}
                </g>
              );
            })}
          </g>
        </svg>
        {!model && !error && <div className="empty-state" style={{ position: 'absolute', inset: 0 }}>Chargement du schéma…</div>}
      </div>
      <div className="result-footer">
        <span>
          {fmtInt(tables.length)} table{tables.length > 1 ? 's' : ''} · {fmtInt(rels.length)} relation{rels.length > 1 ? 's' : ''}
        </span>
        {external.length > 0 && (
          <span title={external.map((r) => `${r.from} → ${r.toSchema}.${r.to}`).join('\n')}>
            <Link2 style={{ width: 12, height: 12, verticalAlign: -2 }} /> {external.length} vers d’autres schémas
          </span>
        )}
        <span>
          <KeyRound style={{ width: 12, height: 12, verticalAlign: -2, color: 'var(--ochre)' }} /> PK · <b style={{ color: 'var(--accent)', fontWeight: 600 }}>FK</b> · * NOT NULL
        </span>
        <span style={{ flex: 1 }} />
        <span className="hint">Glisser : déplacer · Molette : zoom · Clic : relations · Double-clic : données</span>
      </div>
    </div>
  );
}

function CrowFoot({ x, y, dir, color }: { x: number; y: number; dir: 1 | -1; color: string }) {
  const s = 11 * dir;
  return <path d={`M ${x + s} ${y} L ${x} ${y - 6} M ${x + s} ${y} L ${x} ${y} M ${x + s} ${y} L ${x} ${y + 6} M ${x + s + 3 * dir} ${y - 6} L ${x + s + 3 * dir} ${y + 6}`} stroke={color} strokeWidth={1.4} fill="none" />;
}

function OneMark({ x, y, dir, color }: { x: number; y: number; dir: 1 | -1; color: string }) {
  const a = x + 7 * dir;
  const b = x + 11 * dir;
  return <path d={`M ${a} ${y - 6} L ${a} ${y + 6} M ${b} ${y - 6} L ${b} ${y + 6}`} stroke={color} strokeWidth={1.4} fill="none" />;
}

function fmtRows(n: number) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1).replace('.', ',')} M lignes`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace('.', ',')} k lignes`;
  return `${n} ligne${n > 1 ? 's' : ''}`;
}

/** Requête SELECT avec les jointures directes d'une table. */
function joinQuery(t: ErdTable, rels: ErdRelation[], q: (n: string) => string, quote: string) {
  const id = (s: string) => quote + s.replace(new RegExp(quote, 'g'), quote + quote) + quote;
  const lines = [`SELECT t.*`, `FROM ${q(t.name)} t`];
  let i = 1;
  for (const r of rels.filter((r) => r.from === t.name && r.to !== t.name)) {
    const a = `j${i++}`;
    lines.push(`LEFT JOIN ${q(r.to)} ${a} ON ${r.fromColumns.map((c, k) => `${a}.${id(r.toColumns[k])} = t.${id(c)}`).join(' AND ')}`);
  }
  for (const r of rels.filter((r) => r.to === t.name && r.from !== t.name)) {
    const a = `j${i++}`;
    lines.push(`-- LEFT JOIN ${q(r.from)} ${a} ON ${r.fromColumns.map((c, k) => `${a}.${id(c)} = t.${id(r.toColumns[k])}`).join(' AND ')}`);
  }
  lines.push('LIMIT 100;');
  return lines.join('\n');
}

/** SVG autonome : variables CSS remplacées par leurs valeurs, cadré sur le contenu. */
function serializeSvg(svg: SVGSVGElement, b: { x0: number; y0: number; x1: number; y1: number }): string {
  const css = getComputedStyle(document.documentElement);
  const resolve = (v: string) => v.replace(/var\((--[\w-]+)\)/g, (_m, name) => css.getPropertyValue(name).trim() || '#888');
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const g = clone.querySelector('g')!;
  g.setAttribute('transform', '');
  clone.querySelectorAll('*').forEach((el) => {
    for (const a of ['fill', 'stroke']) {
      const v = el.getAttribute(a);
      if (v?.includes('var(')) el.setAttribute(a, resolve(v));
    }
    if (el.getAttribute('opacity')) el.removeAttribute('opacity');
  });
  clone.querySelectorAll('title').forEach((t) => t.remove());
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${b.x0} ${b.y0} ${w} ${h}`);
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  clone.removeAttribute('class');
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', String(b.x0));
  bg.setAttribute('y', String(b.y0));
  bg.setAttribute('width', String(w));
  bg.setAttribute('height', String(h));
  bg.setAttribute('fill', resolve('var(--bg)'));
  clone.insertBefore(bg, clone.firstChild);
  return '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLSerializer().serializeToString(clone);
}
