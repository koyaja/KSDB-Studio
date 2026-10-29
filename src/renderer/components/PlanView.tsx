import dagre from '@dagrejs/dagre';
import { AlertTriangle, ChevronDown, ChevronRight, Copy, Gauge, Info, Maximize2, Minus, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Plan, PlanNode, share, walk } from '../../shared/explain';
import { toast } from '../state';

type View = 'tree' | 'graph' | 'source';

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return '—';
  if (ms < 1) return `${ms.toLocaleString('fr-FR', { maximumFractionDigits: 3 })} ms`;
  if (ms < 1000) return `${ms.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} ms`;
  return `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} s`;
}
const fmtN = (n: number | undefined) => (n === undefined ? '—' : Math.round(n).toLocaleString('fr-FR'));
const fmtCost = (n: number | undefined) => (n === undefined ? '—' : n.toLocaleString('fr-FR', { maximumFractionDigits: n < 10 ? 2 : 0 }));
const pct = (r: number) => `${(r * 100).toLocaleString('fr-FR', { maximumFractionDigits: r < 0.1 ? 1 : 0 })} %`;
const heat = (r: number) => (r >= 0.5 ? 'h3' : r >= 0.2 ? 'h2' : r >= 0.05 ? 'h1' : 'h0');

/** Écart estimation / réalité : ×N, avec le sens */
function misestimate(n: PlanNode): { label: string; bad: boolean } | null {
  if (n.actRows === undefined || n.estRows === undefined) return null;
  const a = Math.max(n.actRows, 1);
  const e = Math.max(n.estRows, 1);
  const r = a > e ? a / e : e / a;
  if (r < 2) return null;
  return { label: `${a > e ? '↑' : '↓'}×${r >= 100 ? Math.round(r).toLocaleString('fr-FR') : r.toLocaleString('fr-FR', { maximumFractionDigits: 1 })}`, bad: r >= 10 };
}

export function PlanView({
  plan,
  rolledBack,
  onReExplain,
}: {
  plan: Plan;
  rolledBack?: boolean;
  onReExplain?: (analyze: boolean) => void;
}) {
  const [view, setView] = useState<View>('tree');
  const [sel, setSel] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [showWarn, setShowWarn] = useState(true);

  const byId = useMemo(() => {
    const m = new Map<number, PlanNode>();
    walk(plan.root, (n) => m.set(n.id, n));
    return m;
  }, [plan]);

  // sélection par défaut : le nœud le plus coûteux
  useEffect(() => {
    let best: PlanNode | null = null;
    let bv = -1;
    walk(plan.root, (n) => {
      const v = share(plan, n).value;
      if (v > bv) {
        bv = v;
        best = n;
      }
    });
    setSel((best as PlanNode | null)?.id ?? null);
    setCollapsed(new Set());
  }, [plan]);

  const selected = sel !== null ? byId.get(sel) : undefined;
  const metricLabel = plan.metric === 'time' ? 'Temps propre' : plan.metric === 'rows' ? 'Lignes examinées (est.)' : 'Coût propre';

  return (
    <div className="plan">
      <div className="plan-bar">
        <span className={`plan-kind ${plan.analyzed ? 'an' : ''}`}>
          <Gauge /> {plan.analyzed ? 'Mesuré (ANALYZE)' : 'Estimé (sans exécution)'}
        </span>
        {plan.analyzed && plan.executionMs !== undefined && (
          <span className="plan-stat">
            Exécution <b>{fmtMs(plan.executionMs)}</b>
          </span>
        )}
        {plan.planningMs !== undefined && (
          <span className="plan-stat">
            {plan.engine === 'postgres' ? 'Planification' : 'Optimisation'} <b>{fmtMs(plan.planningMs)}</b>
          </span>
        )}
        {plan.root.cost !== undefined && (
          <span className="plan-stat">
            Coût <b>{fmtCost(plan.root.cost)}</b>
          </span>
        )}
        {(plan.root.actRows ?? plan.root.estRows) !== undefined && (
          <span className="plan-stat">
            Lignes <b>{fmtN(plan.root.actRows ?? plan.root.estRows)}</b>
          </span>
        )}
        {plan.warnings.length > 0 && (
          <button className={`plan-warnbtn ${showWarn ? 'on' : ''}`} onClick={() => setShowWarn(!showWarn)}>
            <AlertTriangle /> {plan.warnings.length} point{plan.warnings.length > 1 ? 's' : ''} d’attention
          </button>
        )}
        {rolledBack && <span className="plan-stat info">Instruction exécutée puis annulée (ROLLBACK)</span>}
        <span style={{ flex: 1 }} />
        {!plan.analyzed && onReExplain && (
          <button className="btn small outline" onClick={() => onReExplain(true)} title="Exécute la requête pour mesurer les temps réels">
            Mesurer (ANALYZE)
          </button>
        )}
        <div className="seg">
          {(
            [
              ['tree', 'Arbre'],
              ['graph', 'Graphique'],
              ['source', plan.source.trim().startsWith('{') || plan.source.trim().startsWith('[') ? 'JSON' : 'Texte'],
            ] as [View, string][]
          ).map(([id, l]) => (
            <button key={id} className={view === id ? 'active' : ''} onClick={() => setView(id)}>
              {l}
            </button>
          ))}
        </div>
      </div>

      {showWarn && plan.warnings.length > 0 && (
        <div className="plan-warnings">
          {plan.warnings.map((w, i) => (
            <div key={i} className={`plan-warning ${w.level}`} onClick={() => setSel(w.nodeId)}>
              {w.level === 'warn' ? <AlertTriangle /> : <Info />}
              <span>{w.text}</span>
            </div>
          ))}
        </div>
      )}

      <div className="plan-body">
        <div className="plan-main">
          {view === 'tree' && (
            <TreeView plan={plan} sel={sel} onSel={setSel} collapsed={collapsed} setCollapsed={setCollapsed} metricLabel={metricLabel} />
          )}
          {view === 'graph' && <GraphView plan={plan} sel={sel} onSel={setSel} />}
          {view === 'source' && (
            <div style={{ padding: 12, overflow: 'auto', height: '100%' }}>
              <button className="btn small outline" style={{ marginBottom: 8 }} onClick={() => navigator.clipboard.writeText(plan.source).then(() => toast('Plan copié'))}>
                <Copy /> Copier
              </button>
              <pre className="sql-preview" style={{ maxHeight: 'none' }}>
                {plan.source}
              </pre>
            </div>
          )}
        </div>
        {selected && view !== 'source' && <NodeDetail plan={plan} n={selected} onClose={() => setSel(null)} />}
      </div>
    </div>
  );
}

// ---------------- Arbre ----------------

function TreeView(props: {
  plan: Plan;
  sel: number | null;
  onSel: (id: number) => void;
  collapsed: Set<number>;
  setCollapsed: (s: Set<number>) => void;
  metricLabel: string;
}) {
  const { plan, collapsed } = props;
  const rows: { n: PlanNode; depth: number; last: boolean[] }[] = [];
  const visit = (n: PlanNode, depth: number, last: boolean[]) => {
    rows.push({ n, depth, last });
    if (collapsed.has(n.id)) return;
    n.children.forEach((c, i) => visit(c, depth + 1, [...last, i === n.children.length - 1]));
  };
  visit(plan.root, 0, []);
  const selRef = useRef<HTMLTableRowElement>(null);
  useEffect(() => {
    selRef.current?.scrollIntoView({ block: 'nearest' });
  }, [props.sel]);

  return (
    <div className="plan-tree-wrap">
      <table className="plan-tree">
        <thead>
          <tr>
            <th className="op">Opération</th>
            <th className="bar">{props.metricLabel}</th>
            <th className="num">{plan.analyzed ? 'Lignes réelles' : 'Lignes estimées'}</th>
            {plan.analyzed && <th className="num">Estimées</th>}
            {plan.analyzed && <th className="num">Boucles</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map(({ n, depth, last }) => {
            const s = share(plan, n);
            const mis = misestimate(n);
            const open = !collapsed.has(n.id);
            return (
              <tr key={n.id} ref={props.sel === n.id ? selRef : undefined} className={`${props.sel === n.id ? 'sel' : ''} ${n.warnings.length ? 'has-warn' : ''}`} onClick={() => props.onSel(n.id)}>
                <td className="op">
                  <div className="op-cell">
                    {last.map((l, i) => (
                      <span key={i} className={`guide ${i === last.length - 1 ? (l ? 'end' : 'mid') : l ? '' : 'line'}`} />
                    ))}
                    {n.children.length ? (
                      <button
                        className="twisty"
                        onClick={(e) => {
                          e.stopPropagation();
                          const c = new Set(collapsed);
                          c.has(n.id) ? c.delete(n.id) : c.add(n.id);
                          props.setCollapsed(c);
                        }}
                      >
                        {open ? <ChevronDown /> : <ChevronRight />}
                      </button>
                    ) : (
                      <span className="twisty" />
                    )}
                    <span className={`dot ${heat(s.ratio)}`} />
                    <span className="title">{n.title}</span>
                    {n.relation && <span className="rel mono">{n.relation}</span>}
                    {n.alias && <span className="hint sm mono">{n.alias}</span>}
                    {n.index && <span className="idx mono">{n.index}</span>}
                    {n.warnings.length > 0 && <AlertTriangle className="w" />}
                    {!open && <span className="hint sm">({n.children.length})</span>}
                  </div>
                  {depth >= 0 && n.details[0] && /Filtre|Condition|Clé/.test(n.details[0].label) && (
                    <div className="op-sub mono" style={{ paddingLeft: 14 * last.length + 36 }} title={n.details[0].value}>
                      {n.details[0].value}
                    </div>
                  )}
                </td>
                <td className="bar">
                  <div className="bar-cell">
                    <div className="track">
                      <div className={`fill ${heat(s.ratio)}`} style={{ width: `${Math.max(s.ratio * 100, s.value > 0 ? 1 : 0)}%` }} />
                    </div>
                    <span className="v">{plan.metric === 'time' ? fmtMs(n.selfMs) : plan.metric === 'rows' ? fmtN(n.selfCost) : fmtCost(n.selfCost)}</span>
                    <span className="p">{pct(s.ratio)}</span>
                  </div>
                </td>
                <td className="num">
                  {fmtN(plan.analyzed ? n.actRows : n.estRows)}
                  {n.removed ? <div className="hint sm">−{fmtN(n.removed)} filtrées</div> : null}
                </td>
                {plan.analyzed && (
                  <td className="num">
                    {fmtN(n.estRows)}
                    {mis && <span className={`mis ${mis.bad ? 'bad' : ''}`}>{mis.label}</span>}
                  </td>
                )}
                {plan.analyzed && <td className="num">{n.loops === undefined ? '' : fmtN(n.loops)}</td>}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------- Graphique ----------------

const GW = 230;
const GH = 78;

function GraphView({ plan, sel, onSel }: { plan: Plan; sel: number | null; onSel: (id: number) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const layout = useMemo(() => {
    const g = new dagre.graphlib.Graph();
    g.setGraph({ rankdir: 'TB', nodesep: 26, ranksep: 46, marginx: 30, marginy: 30 });
    g.setDefaultEdgeLabel(() => ({}));
    const edges: { from: PlanNode; to: PlanNode }[] = [];
    walk(plan.root, (n, _d, parent) => {
      g.setNode(String(n.id), { width: GW, height: GH });
      if (parent) {
        g.setEdge(String(parent.id), String(n.id));
        edges.push({ from: n, to: parent });
      }
    });
    dagre.layout(g);
    const pos = new Map<number, { x: number; y: number }>();
    walk(plan.root, (n) => {
      const nd = g.node(String(n.id));
      pos.set(n.id, { x: nd.x - GW / 2, y: nd.y - GH / 2 });
    });
    const gr = g.graph();
    return { pos, edges, w: gr.width ?? 600, h: gr.height ?? 400 };
  }, [plan]);

  const maxRows = useMemo(() => {
    let m = 1;
    walk(plan.root, (n) => (m = Math.max(m, n.actRows ?? n.estRows ?? 0)));
    return m;
  }, [plan]);

  const [v, setV] = useState({ x: 0, y: 0, k: 1 });
  const fit = () => {
    const r = host.current?.getBoundingClientRect();
    if (!r) return;
    // lisible d'abord : on n'écrase pas un plan profond, il se parcourt en glissant
    const k = Math.min(1, Math.max(0.85, Math.min(r.width / layout.w, r.height / layout.h)));
    setV({ k, x: (r.width - layout.w * k) / 2, y: Math.max(0, (r.height - layout.h * k) / 2) });
  };
  useEffect(() => {
    fit();
  }, [layout]);

  const zoomAt = (f: number, cx: number, cy: number) =>
    setV((o) => {
      const k = Math.min(2.5, Math.max(0.15, o.k * f));
      const ff = k / o.k;
      return { k, x: cx - (cx - o.x) * ff, y: cy - (cy - o.y) * ff };
    });

  const onDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    const v0 = v;
    const mv = (ev: MouseEvent) => setV({ ...v0, x: v0.x + ev.clientX - sx, y: v0.y + ev.clientY - sy });
    const up = () => {
      window.removeEventListener('mousemove', mv);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  };

  return (
    <div
      className="plan-graph"
      ref={host}
      onMouseDown={onDown}
      onWheel={(e) => {
        const r = host.current!.getBoundingClientRect();
        zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      }}
    >
      <div className="plan-zoom" onMouseDown={(e) => e.stopPropagation()}>
        <button className="btn icon" title="Zoom avant" onClick={() => zoomAt(1.2, 100, 100)}>
          <Plus />
        </button>
        <button className="btn icon" title="Zoom arrière" onClick={() => zoomAt(1 / 1.2, 100, 100)}>
          <Minus />
        </button>
        <button className="btn icon" title="Ajuster" onClick={fit}>
          <Maximize2 />
        </button>
      </div>
      <svg width="100%" height="100%">
        <g transform={`translate(${v.x} ${v.y}) scale(${v.k})`}>
          {layout.edges.map(({ from, to }) => {
            const a = layout.pos.get(from.id)!;
            const b = layout.pos.get(to.id)!;
            const x1 = a.x + GW / 2;
            const y1 = a.y;
            const x2 = b.x + GW / 2;
            const y2 = b.y + GH;
            const rows = from.actRows ?? from.estRows ?? 0;
            const w = 1.5 + 7 * (Math.log10(rows + 1) / Math.log10(maxRows + 1));
            const my = (y1 + y2) / 2;
            return (
              <g key={from.id}>
                <path d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} className="plan-edge" strokeWidth={w} />
                <text x={(x1 + x2) / 2 + 6} y={my} className="plan-edge-label">
                  {fmtN(rows)}
                </text>
              </g>
            );
          })}
          {[...layout.pos.entries()].map(([id, p]) => {
            const n = findNode(plan.root, id)!;
            const s = share(plan, n);
            return (
              <g
                key={id}
                transform={`translate(${p.x} ${p.y})`}
                className={`plan-node ${sel === id ? 'sel' : ''}`}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onSel(id)}
              >
                <rect width={GW} height={GH} rx={7} className="box" />
                <rect width={5} height={GH} rx={2} className={`heat ${heat(s.ratio)}`} />
                <rect x={12} y={GH - 10} width={GW - 24} height={3} rx={1.5} className="track" />
                <rect x={12} y={GH - 10} width={Math.max((GW - 24) * s.ratio, s.value > 0 ? 2 : 0)} height={3} rx={1.5} className={`fill ${heat(s.ratio)}`} />
                <text x={14} y={20} className="t">
                  {clip(n.title, 30)}
                </text>
                {n.warnings.length > 0 && (
                  <text x={GW - 12} y={20} textAnchor="end" className="warn">
                    ⚠
                  </text>
                )}
                <text x={14} y={38} className="r">
                  {clip([n.relation, n.index && `(${n.index})`].filter(Boolean).join(' ') || n.details[0]?.value || '', 34)}
                </text>
                <text x={14} y={56} className="m">
                  {plan.metric === 'time' ? fmtMs(n.selfMs) : plan.metric === 'rows' ? `${fmtN(n.selfCost)} lues` : `coût ${fmtCost(n.selfCost)}`} · {pct(s.ratio)} · {fmtN(n.actRows ?? n.estRows)} l.
                </text>
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function findNode(r: PlanNode, id: number): PlanNode | undefined {
  if (r.id === id) return r;
  for (const c of r.children) {
    const f = findNode(c, id);
    if (f) return f;
  }
}

// ---------------- Détail ----------------

function NodeDetail({ plan, n, onClose }: { plan: Plan; n: PlanNode; onClose: () => void }) {
  const s = share(plan, n);
  const mis = misestimate(n);
  const [raw, setRaw] = useState(false);
  const rows: [string, string][] = [];
  if (plan.analyzed) {
    rows.push(['Temps total', fmtMs(n.totalMs)], ['Temps propre', `${fmtMs(n.selfMs)} (${pct(s.ratio)})`]);
    rows.push(['Lignes réelles', fmtN(n.actRows)], ['Lignes estimées', fmtN(n.estRows) + (mis ? `  ${mis.label}` : '')]);
    if (n.loops !== undefined) rows.push(['Boucles', fmtN(n.loops)]);
  } else {
    rows.push(['Lignes estimées', fmtN(n.estRows)]);
    if (n.selfCost !== undefined) rows.push([plan.metric === 'rows' ? 'Lignes examinées' : 'Coût propre', `${plan.metric === 'rows' ? fmtN(n.selfCost) : fmtCost(n.selfCost)} (${pct(s.ratio)})`]);
  }
  if (n.cost !== undefined) rows.push(['Coût cumulé', fmtCost(n.cost)]);
  if (n.removed) rows.push(['Lignes écartées', fmtN(n.removed)]);
  if (n.hit !== undefined || n.read !== undefined) rows.push(['Blocs en cache / lus', `${fmtN(n.hit ?? 0)} / ${fmtN(n.read ?? 0)}`]);
  return (
    <div className="plan-detail">
      <div className="plan-detail-head">
        <h4>{n.title}</h4>
        <button className="btn icon" onClick={onClose} aria-label="Fermer">
          <X />
        </button>
      </div>
      {(n.relation || n.index) && (
        <div className="plan-detail-rel mono">
          {n.relation}
          {n.alias ? ` ${n.alias}` : ''}
          {n.index && <div className="hint">index {n.index}</div>}
        </div>
      )}
      {n.warnings.map((w, i) => (
        <div key={i} className="plan-warning warn" style={{ margin: '8px 0' }}>
          <AlertTriangle /> <span>{w}</span>
        </div>
      ))}
      <dl className="plan-kv">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {n.details.length > 0 && (
        <dl className="plan-kv det">
          {n.details.map((d, i) => (
            <div key={i}>
              <dt>{d.label}</dt>
              <dd className="mono">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <button className="btn small" style={{ marginTop: 8 }} onClick={() => setRaw(!raw)}>
        {raw ? <ChevronDown /> : <ChevronRight />} Propriétés brutes
      </button>
      {raw && (
        <pre className="sql-preview" style={{ maxHeight: 300, fontSize: 11 }}>
          {JSON.stringify(Object.fromEntries(Object.entries(n.raw).filter(([k]) => k !== 'Plans' && k !== 'nested_loop')), null, 2)}
        </pre>
      )}
    </div>
  );
}
