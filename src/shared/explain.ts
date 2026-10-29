// Plans d'exécution : conversion des formats PostgreSQL (JSON), MariaDB / MySQL (JSON) et MySQL 8 (TREE)
// vers un modèle commun, puis repérage des points faibles.

export interface PlanNode {
  id: number;
  /** type d'opération (Seq Scan, Hash Join, table…) */
  op: string;
  /** libellé complet affiché */
  title: string;
  /** table / objet concerné */
  relation?: string;
  alias?: string;
  index?: string;
  /** lignes de détail : filtre, condition de jointure, clé de tri… */
  details: { label: string; value: string }[];
  estRows?: number;
  /** lignes réelles (total sur toutes les boucles) */
  actRows?: number;
  loops?: number;
  /** coût estimé cumulé (unités du moteur) */
  cost?: number;
  /** durée totale du nœud et de ses enfants, en ms (ANALYZE) */
  totalMs?: number;
  /** durée propre au nœud, en ms */
  selfMs?: number;
  /** coût propre (coût cumulé moins celui des enfants) */
  selfCost?: number;
  /** lignes filtrées / supprimées */
  removed?: number;
  /** blocs lus en cache / sur disque (PG BUFFERS) */
  hit?: number;
  read?: number;
  /** PG : exécuté par des workers parallèles (les « boucles » sont les processus) */
  parallel?: boolean;
  warnings: string[];
  children: PlanNode[];
  /** propriétés brutes (panneau de détail) */
  raw: Record<string, unknown>;
}

export interface Plan {
  engine: 'postgres' | 'mysql' | 'mariadb';
  analyzed: boolean;
  root: PlanNode;
  planningMs?: number;
  executionMs?: number;
  /** total de référence pour les pourcentages (temps si ANALYZE, sinon coût) */
  /** time : ANALYZE ; cost : coût du moteur ; rows : lignes examinées estimées (MariaDB sans coût) */
  metric: 'time' | 'cost' | 'rows';
  total: number;
  warnings: { nodeId: number; text: string; level: 'warn' | 'info' }[];
  /** sortie brute (JSON ou texte) */
  source: string;
}

let seq = 0;
const node = (op: string, raw: Record<string, unknown> = {}): PlanNode => ({ id: ++seq, op, title: op, details: [], warnings: [], children: [], raw });
const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : undefined;
};
const fmt = (n: number) => n.toLocaleString('fr-FR', { maximumFractionDigits: 0 });

// ---------------- PostgreSQL ----------------

const PG_DETAIL_KEYS: [string, string][] = [
  ['Index Cond', 'Condition d’index'],
  ['Recheck Cond', 'Revérification'],
  ['Hash Cond', 'Condition de hachage'],
  ['Merge Cond', 'Condition de fusion'],
  ['Join Filter', 'Filtre de jointure'],
  ['Filter', 'Filtre'],
  ['Sort Key', 'Clé de tri'],
  ['Presorted Key', 'Déjà trié sur'],
  ['Group Key', 'Regroupement'],
  ['Sort Method', 'Méthode de tri'],
  ['Strategy', 'Stratégie'],
  ['CTE Name', 'CTE'],
  ['Subplan Name', 'Sous-plan'],
  ['Function Name', 'Fonction'],
  ['Workers Planned', 'Workers prévus'],
  ['Workers Launched', 'Workers lancés'],
  ['Heap Fetches', 'Lectures de la table'],
  ['Hash Batches', 'Lots de hachage'],
  ['Peak Memory Usage', 'Mémoire max (ko)'],
  ['Sort Space Used', 'Espace de tri (ko)'],
  ['Sort Space Type', 'Tri en'],
];

function pgTitle(p: Record<string, unknown>): string {
  const t = String(p['Node Type'] ?? '?');
  const join = p['Join Type'] && p['Join Type'] !== 'Inner' ? ` ${String(p['Join Type'])}` : '';
  if (t === 'Aggregate' && p['Strategy']) {
    const s = String(p['Strategy']);
    return s === 'Hashed' ? 'HashAggregate' : s === 'Sorted' ? 'GroupAggregate' : s === 'Mixed' ? 'MixedAggregate' : 'Aggregate';
  }
  if (t === 'ModifyTable' && p['Operation']) return String(p['Operation']);
  return t + join;
}

function pgNode(p: Record<string, unknown>, analyzed: boolean, parallel = false): PlanNode {
  const n = node(String(p['Node Type'] ?? '?'), p);
  n.title = pgTitle(p);
  n.parallel = parallel;
  if (p['Relation Name']) n.relation = (p['Schema'] ? `${String(p['Schema'])}.` : '') + String(p['Relation Name']);
  if (p['Alias'] && p['Alias'] !== p['Relation Name']) n.alias = String(p['Alias']);
  if (p['Index Name']) n.index = String(p['Index Name']);
  if (p['CTE Name'] && !n.relation) n.relation = String(p['CTE Name']);
  if (p['Function Name'] && !n.relation) n.relation = String(p['Function Name']);
  if (p['Parent Relationship'] === 'InitPlan' || p['Parent Relationship'] === 'SubPlan') n.title += ` (${String(p['Subplan Name'] ?? p['Parent Relationship'])})`;
  for (const [k, label] of PG_DETAIL_KEYS) {
    const v = p[k];
    if (v === undefined || v === null || k === 'CTE Name' || k === 'Subplan Name' || k === 'Function Name') continue;
    n.details.push({ label, value: Array.isArray(v) ? v.join(', ') : String(v) });
  }
  n.estRows = num(p['Plan Rows']);
  n.cost = num(p['Total Cost']);
  const loops = num(p['Actual Loops']);
  if (analyzed && loops !== undefined) {
    n.loops = loops;
    n.actRows = (num(p['Actual Rows']) ?? 0) * loops;
    // sous un Gather, les boucles sont les workers qui tournent en même temps : la durée réelle est la moyenne
    n.totalMs = (num(p['Actual Total Time']) ?? 0) * (parallel ? 1 : loops);
    // l'estimation de PG est par boucle : on la ramène au total pour comparer
    if (n.estRows !== undefined) n.estRows = n.estRows * loops;
  }
  const removed = (num(p['Rows Removed by Filter']) ?? 0) + (num(p['Rows Removed by Index Recheck']) ?? 0) + (num(p['Rows Removed by Join Filter']) ?? 0);
  if (removed) n.removed = removed * (loops ?? 1);
  n.hit = num(p['Shared Hit Blocks']);
  n.read = num(p['Shared Read Blocks']);
  const par = parallel || /^Gather/.test(String(p['Node Type']));
  for (const c of (p['Plans'] as Record<string, unknown>[] | undefined) ?? []) n.children.push(pgNode(c, analyzed, par));
  return n;
}

export function parsePgPlan(json: string): Plan {
  seq = 0;
  const data = JSON.parse(json);
  const top = (Array.isArray(data) ? data[0] : data) as Record<string, unknown>;
  const p = top['Plan'] as Record<string, unknown>;
  const analyzed = p['Actual Loops'] !== undefined;
  const root = pgNode(p, analyzed);
  // les nœuds parallèles (Gather) : Actual Loops des workers inclut le leader, durée moyenne par boucle
  return finish({
    engine: 'postgres',
    analyzed,
    root,
    planningMs: num(top['Planning Time']),
    executionMs: num(top['Execution Time']),
    metric: analyzed ? 'time' : 'cost',
    total: 0,
    warnings: [],
    source: JSON.stringify(data, null, 2),
  });
}

// ---------------- MariaDB / MySQL (FORMAT=JSON) ----------------

const MY_LABEL: Record<string, string> = {
  filesort: 'Tri',
  ordering_operation: 'Tri',
  grouping_operation: 'Regroupement',
  duplicates_removal: 'Dédoublonnage',
  temporary_table: 'Table temporaire',
  nested_loop: 'Boucle imbriquée',
  'block-nl-join': 'Jointure par blocs',
  union_result: 'UNION',
  materialized_from_subquery: 'Sous-requête matérialisée',
  read_sorted_file: 'Lecture du tri',
  window_functions_computation: 'Fonctions de fenêtrage',
  windowing: 'Fonctions de fenêtrage',
  having_condition: 'HAVING',
  subqueries: 'Sous-requêtes',
  attached_subqueries: 'Sous-requêtes',
  optimized_away_subqueries: 'Sous-requêtes',
  'expression-cache': 'Cache d’expression',
};

function myCost(o: Record<string, unknown>): number | undefined {
  const ci = o['cost_info'] as Record<string, unknown> | undefined;
  return num(ci?.['prefix_cost']) ?? num(ci?.['query_cost']) ?? num(ci?.['sort_cost']);
}

function myTable(t: Record<string, unknown>): PlanNode {
  const n = node('table', t);
  const access = String(t['access_type'] ?? '');
  const ACCESS: Record<string, string> = {
    ALL: 'Parcours complet',
    index: 'Parcours complet de l’index',
    range: 'Plage d’index',
    ref: 'Recherche par index',
    eq_ref: 'Recherche unique par index',
    const: 'Ligne constante',
    system: 'Ligne constante',
    ref_or_null: 'Recherche par index (ou NULL)',
    index_merge: 'Fusion d’index',
    fulltext: 'Recherche plein texte',
    hash_ALL: 'Jointure par hachage (parcours)',
    hash_range: 'Jointure par hachage (plage)',
    hash_index: 'Jointure par hachage (index)',
  };
  n.op = access || 'table';
  n.title = ACCESS[access] ?? (access || 'Table');
  n.relation = String(t['table_name'] ?? '?');
  if (t['key']) n.index = String(t['key']);
  const det = (label: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== '') n.details.push({ label, value: Array.isArray(v) ? v.join(', ') : String(v) });
  };
  det('Index possibles', t['possible_keys']);
  det('Colonnes de l’index', t['used_key_parts']);
  det('Référence', t['ref']);
  det('Condition', t['attached_condition']);
  det('Condition d’index', t['index_condition']);
  det('Tampon de jointure', t['using_join_buffer']);
  if (t['using_index']) det('Index couvrant', 'oui');
  if (t['using_temporary_table']) det('Table temporaire', 'oui');
  if (t['using_filesort']) det('Tri (filesort)', 'oui');
  det('Filtré (%)', t['filtered']);
  const loops = num(t['r_loops']);
  // MariaDB : rows = estimation par parcours ; MySQL : rows_examined_per_scan
  const est = num(t['rows']) ?? num(t['rows_examined_per_scan']);
  n.cost = myCost(t);
  if (loops !== undefined) {
    n.loops = loops;
    // MariaDB : r_rows = lignes examinées par boucle, r_filtered = % conservé après la condition
    const rPerLoop = num(t['r_rows']);
    const rf = num(t['r_filtered']) ?? 100;
    if (rPerLoop !== undefined) {
      const examined = rPerLoop * loops;
      n.actRows = Math.round((examined * rf) / 100);
      if (rf < 100) n.removed = Math.round(examined - n.actRows);
      n.details.push({ label: 'Lignes examinées', value: fmt(examined) });
    }
    const f = num(t['filtered']) ?? 100;
    if (est !== undefined) n.estRows = Math.round((est * Math.max(loops, 1) * f) / 100);
    const ms = (num(t['r_table_time_ms']) ?? 0) + (num(t['r_other_time_ms']) ?? 0);
    if (ms) n.totalMs = ms;
  } else if (est !== undefined) n.estRows = est;
  // MySQL 8 : sous-requête matérialisée dans la table dérivée
  const mat = t['materialized_from_subquery'] as Record<string, unknown> | undefined;
  if (mat) n.children.push(...myChildren(mat));
  for (const k of ['attached_subqueries', 'subqueries']) for (const s of (t[k] as Record<string, unknown>[] | undefined) ?? []) n.children.push(...myChildren(s));
  return n;
}

/** Convertit un objet du plan JSON MySQL / MariaDB en nœuds */
function myChildren(o: Record<string, unknown>): PlanNode[] {
  const out: PlanNode[] = [];
  for (const [k, v] of Object.entries(o)) {
    if (v === null || typeof v !== 'object') continue;
    if (k === 'query_block') {
      out.push(myBlock(v as Record<string, unknown>));
    } else if (k === 'table') {
      out.push(myTable(v as Record<string, unknown>));
    } else if (k === 'nested_loop' && Array.isArray(v)) {
      const items = v.flatMap((x) => myChildren(x as Record<string, unknown>));
      if (items.length === 1) out.push(items[0]);
      else {
        const n = node('nested_loop', {});
        n.title = 'Boucle imbriquée';
        n.children = items;
        out.push(n);
      }
    } else if (k === 'query_specifications' && Array.isArray(v)) {
      for (const s of v) out.push(...myChildren(s as Record<string, unknown>));
    } else if (Array.isArray(v) && MY_LABEL[k]) {
      for (const s of v) out.push(...myChildren(s as Record<string, unknown>));
    } else if (MY_LABEL[k] || k === 'block-nl-join') {
      const obj = v as Record<string, unknown>;
      const n = node(k, obj);
      n.title = MY_LABEL[k] ?? k;
      if (k === 'ordering_operation' && obj['using_filesort']) n.title = 'Tri (filesort)';
      if (k === 'grouping_operation' && obj['using_temporary_table']) n.title = 'Regroupement (table temporaire)';
      if (obj['sort_key']) n.details.push({ label: 'Clé de tri', value: String(obj['sort_key']) });
      if (obj['attached_condition']) n.details.push({ label: 'Condition', value: String(obj['attached_condition']) });
      if (obj['r_sort_mode']) n.details.push({ label: 'Mode de tri', value: String(obj['r_sort_mode']) });
      if (obj['r_used_priority_queue']) n.details.push({ label: 'File de priorité (LIMIT)', value: 'oui' });
      if (obj['r_output_rows'] !== undefined) n.actRows = num(obj['r_output_rows']);
      if (obj['r_loops'] !== undefined) n.loops = num(obj['r_loops']);
      const ms = num(obj['r_total_time_ms']);
      if (ms) n.totalMs = ms;
      n.cost = myCost(obj);
      if (k === 'having_condition') n.details.push({ label: 'Condition', value: String(v) });
      n.children = myChildren(obj);
      // un nœud « Sous-requêtes » sans contenu propre se résume à ses enfants
      out.push(n);
    }
  }
  return out;
}

function myBlock(b: Record<string, unknown>): PlanNode {
  const n = node('query_block', b);
  n.title = `Requête #${String(b['select_id'] ?? 1)}`;
  if (b['message']) n.details.push({ label: 'Message', value: String(b['message']) });
  const ms = num(b['r_total_time_ms']);
  if (ms) n.totalMs = ms;
  n.loops = num(b['r_loops']);
  n.cost = myCost(b);
  n.children = myChildren(b);
  if (b['having_condition']) n.details.push({ label: 'HAVING', value: String(b['having_condition']) });
  return n;
}

export function parseMysqlJson(json: string, engine: 'mysql' | 'mariadb'): Plan {
  seq = 0;
  const data = JSON.parse(json) as Record<string, unknown>;
  const qb = data['query_block'] as Record<string, unknown>;
  if (!qb) throw new Error('Plan JSON inattendu : query_block absent');
  const root = myBlock(qb);
  const analyzed = JSON.stringify(data).includes('"r_loops"');
  const opt = data['query_optimization'] as Record<string, unknown> | undefined;
  return finish({
    engine,
    analyzed,
    root,
    planningMs: num(opt?.['r_total_time_ms']),
    executionMs: analyzed ? root.totalMs : undefined,
    metric: analyzed ? 'time' : 'cost',
    total: 0,
    warnings: [],
    source: JSON.stringify(data, null, 2),
  });
}

// ---------------- MySQL 8 : EXPLAIN FORMAT=TREE / EXPLAIN ANALYZE ----------------

const TREE_LINE = /^(\s*)-> (.*?)(?:\s+\(cost=([\d.e+]+)(?:\.\.([\d.e+]+))?\s+rows=([\d.e+]+)\))?(?:\s+\(actual time=([\d.e+]+)\.\.([\d.e+]+) rows=([\d.e+]+) loops=(\d+)\))?(?:\s+\(never executed\))?\s*$/;

export function parseMysqlTree(text: string): Plan {
  seq = 0;
  const lines = text.split('\n').filter((l) => l.trim());
  const stack: { indent: number; n: PlanNode }[] = [];
  let root: PlanNode | null = null;
  let analyzed = false;
  for (const line of lines) {
    const m = TREE_LINE.exec(line);
    if (!m) {
      // ligne de continuation : rattachée au nœud courant
      if (stack.length) stack[stack.length - 1].n.details.push({ label: 'Détail', value: line.trim() });
      continue;
    }
    const indent = m[1].length;
    const desc = m[2];
    const n = node(desc.split(/[: ]/)[0] || desc, { line: line.trim() });
    n.title = desc;
    const on = /\bon (\S+)/.exec(desc);
    if (/scan|lookup|on /i.test(desc) && on) n.relation = on[1];
    const idx = /using (\S+)/.exec(desc);
    if (idx) n.index = idx[1].replace(/[()]/g, '');
    const kind = /^(Table scan|Index scan|Index range scan|Index lookup|Single-row index lookup|Covering index lookup|Covering index scan|Filter|Sort|Aggregate|Group aggregate|Nested loop \w+ join|Inner hash join|Left hash join|Hash|Limit|Materialize|Stream results|Temporary table)/i.exec(desc);
    if (kind) n.op = kind[1];
    const cond = /^Filter: (.*)$/.exec(desc);
    if (cond) n.details.push({ label: 'Filtre', value: cond[1] });
    n.cost = num(m[4] ?? m[3]);
    n.estRows = num(m[5]);
    if (m[7] !== undefined) {
      analyzed = true;
      const loops = num(m[9]) ?? 1;
      n.loops = loops;
      n.actRows = Math.round((num(m[8]) ?? 0) * loops);
      n.totalMs = (num(m[7]) ?? 0) * loops;
      if (n.estRows !== undefined) n.estRows *= loops;
    } else if (/never executed/.test(line)) {
      analyzed = true;
      n.loops = 0;
      n.actRows = 0;
      n.totalMs = 0;
    }
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length) stack[stack.length - 1].n.children.push(n);
    else if (!root) root = n;
    else {
      // plusieurs racines : on les regroupe
      const r = node('root');
      r.title = 'Requête';
      r.children = [root, n];
      root = r;
    }
    stack.push({ indent, n });
  }
  if (!root) throw new Error('Plan vide');
  return finish({ engine: 'mysql', analyzed, root, executionMs: analyzed ? root.totalMs : undefined, metric: analyzed ? 'time' : 'cost', total: 0, warnings: [], source: text });
}

// ---------------- Calculs et diagnostics ----------------

export function walk(n: PlanNode, fn: (n: PlanNode, depth: number, parent?: PlanNode) => void, depth = 0, parent?: PlanNode) {
  fn(n, depth, parent);
  for (const c of n.children) walk(c, fn, depth + 1, n);
}

function computeSelf(n: PlanNode, pg: boolean) {
  for (const c of n.children) computeSelf(c, pg);
  // InitPlan / CTE : leur durée n'est pas toujours comprise dans celle du parent
  const kids = n.children.filter((c) => !(pg && /InitPlan|SubPlan/.test(String(c.raw['Parent Relationship'] ?? ''))));
  const childMs = kids.reduce((a, c) => a + (c.totalMs ?? 0), 0);
  if (n.totalMs !== undefined) {
    if (!pg && n.totalMs < childMs) {
      // MariaDB : r_total_time_ms d'un tri ne compte que le tri lui-même
      n.selfMs = n.totalMs;
      n.totalMs = n.totalMs + childMs;
    } else n.selfMs = Math.max(0, n.totalMs - childMs);
  } else if (childMs) {
    n.totalMs = childMs;
    n.selfMs = 0;
  }
  if (n.cost !== undefined) {
    const childCost = kids.reduce((a, c) => a + (c.cost ?? 0), 0);
    n.selfCost = Math.max(0, n.cost - childCost);
  }
}

/** Colonnes citées dans une condition simple : (col = …), col > …, t.col IN … */
export function conditionColumns(cond: string): string[] {
  const out = new Set<string>();
  // PG VERBOSE : ((o.statut)::text = 'payee'::text) ; MySQL : `t`.`col` > 3
  const re = /(?:^|[(\s,])(?:["`]?[\w$]+["`]?\.)*["`]?([A-Za-z_][\w$]*)["`]?\)?(?:::[\w ]+?(?:\[\])?)?\s*(?:=|<>|!=|<=|>=|<|>|~~\*?|!~~|\bLIKE\b|\bIN\b|\bBETWEEN\b|\bIS\b|= ANY)/gi;
  for (const m of cond.matchAll(re)) {
    const c = m[1];
    // argument d'une fonction (lower(nom) = …) : un index simple sur la colonne ne servirait pas
    const at = m.index! + m[0].indexOf(c);
    if (/[A-Za-z_]\w*\((?:["`]?[\w$]+["`]?\.)*["`]?$/.test(cond.slice(0, at))) continue;
    if (!/^(AND|OR|NOT|NULL|TRUE|FALSE|SubPlan|InitPlan|ANY|ALL)$/i.test(c) && !/^\$\d+$/.test(c)) out.add(c);
  }
  return [...out];
}

function diagnose(plan: Plan) {
  const pg = plan.engine === 'postgres';
  walk(plan.root, (n, _depth, parent) => {
    const add = (text: string, level: 'warn' | 'info' = 'warn') => {
      n.warnings.push(text);
      plan.warnings.push({ nodeId: n.id, text, level });
    };
    const rows = n.actRows ?? n.estRows ?? 0;
    // parcours complet coûteux
    const fullScan = pg ? n.op === 'Seq Scan' : n.op === 'ALL' || /^Table scan/i.test(n.op);
    if (fullScan) {
      const read = (n.actRows ?? 0) + (n.removed ?? 0) || n.estRows || 0;
      const filter = n.details.find((d) => /Filtre|Condition/.test(d.label))?.value;
      if (filter && n.removed !== undefined && n.removed > 1000 && n.removed > 0.8 * read) {
        const cols = conditionColumns(filter);
        add(
          `Parcours complet de ${n.relation} : ${fmt(read)} lignes lues pour ${fmt(n.actRows ?? 0)} gardées.` +
            (cols.length ? ` Un index sur ${n.relation} (${cols.join(', ')}) éviterait de tout lire.` : ' Un index sur les colonnes du filtre éviterait de tout lire.'),
        );
      } else if (read >= 10000 && (n.loops ?? 1) > 1 && !n.parallel) {
        add(`Parcours complet de ${n.relation} répété ${fmt(n.loops ?? 1)} fois (${fmt(read)} lignes lues au total) : un index sur la colonne de jointure l’éviterait.`);
      } else if (read >= 100000) {
        add(`Parcours complet de ${n.relation} (${fmt(read)} lignes).`, filter ? 'warn' : 'info');
      }
    }
    // estimation très éloignée de la réalité
    // sous un LIMIT, le nœud s'arrête dès qu'il a assez de lignes : l'écart est normal
    if (n.actRows !== undefined && n.estRows !== undefined && (n.loops ?? 1) > 0 && !/^Limit/.test(parent?.op ?? '')) {
      const a = Math.max(n.actRows, 1);
      const e = Math.max(n.estRows, 1);
      const ratio = a > e ? a / e : e / a;
      if (ratio >= 10 && Math.max(a, e) >= 1000) {
        add(
          `Estimation ${a > e ? 'trop basse' : 'trop haute'} : ${fmt(n.estRows)} lignes prévues, ${fmt(n.actRows)} réelles (×${Math.round(ratio)}).` +
            (n.relation ? ` Mets à jour les statistiques : ${pg ? `ANALYZE ${n.relation}` : `ANALYZE TABLE ${n.relation}`}.` : ''),
          'info',
        );
      }
    }
    if (pg) {
      if (n.raw['Sort Space Type'] === 'Disk') add(`Tri sur disque (${fmt(num(n.raw['Sort Space Used']) ?? 0)} ko) : augmente work_mem pour cette requête (SET work_mem = '64MB').`);
      if ((num(n.raw['Hash Batches']) ?? 1) > 1) add(`Table de hachage découpée en ${String(n.raw['Hash Batches'])} lots sur disque : augmente work_mem.`);
      if ((num(n.raw['HashAgg Batches']) ?? 1) > 1 || (num(n.raw['Disk Usage']) ?? 0) > 0) add('Agrégation débordant sur disque : augmente work_mem.');
      const tempW = num(n.raw['Temp Written Blocks']) ?? 0;
      if (tempW > 1000 && !n.children.some((c) => (num(c.raw['Temp Written Blocks']) ?? 0) >= tempW)) add(`${fmt(tempW)} blocs temporaires écrits sur disque.`, 'info');
      if (n.op === 'Index Only Scan' && (num(n.raw['Heap Fetches']) ?? 0) > 1000) add(`Index Only Scan avec ${fmt(num(n.raw['Heap Fetches']) ?? 0)} lectures de la table : un VACUUM de ${n.relation} le rendrait plus efficace.`, 'info');
      if (n.op === 'Nested Loop' && (n.children[1]?.loops ?? 0) > 10000 && n.children[1]?.op === 'Seq Scan')
        add('Boucle imbriquée sur un parcours complet : très coûteux, un index sur la condition de jointure est recommandé.');
      const wp = num(n.raw['Workers Planned']);
      const wl = num(n.raw['Workers Launched']);
      if (wp !== undefined && wl !== undefined && wl < wp) add(`Seulement ${wl} worker(s) lancé(s) sur ${wp} prévus : max_parallel_workers est saturé.`, 'info');
    } else {
      if (n.raw['using_filesort'] || n.op === 'filesort' || /^Sort\b/.test(n.op)) {
        if (rows >= 10000) add(`Tri de ${fmt(rows)} lignes : un index sur les colonnes de ORDER BY l’éviterait.`, 'info');
      }
      if (n.raw['using_temporary_table'] && rows >= 10000) add('Table temporaire pour le regroupement : un index sur les colonnes du GROUP BY peut l’éviter.', 'info');
      if (n.op === 'ALL' && !n.raw['possible_keys'] && rows >= 1000 && n.loops !== undefined && n.loops > 1)
        add(`Aucun index utilisable sur ${n.relation} pour cette jointure.`);
    }
  });
}

/** Lignes examinées estimées : dans une boucle imbriquée, chaque table est lue autant de fois que les lignes produites avant elle. */
function examinedRows(n: PlanNode, outer: number): number {
  if (n.op === 'nested_loop') {
    let prefix = outer;
    for (const c of n.children) prefix = Math.max(1, examinedRows(c, prefix));
    n.selfCost = 0;
    return prefix;
  }
  if (n.raw['table_name'] !== undefined) {
    const rows = num(n.raw['rows']) ?? num(n.raw['rows_examined_per_scan']) ?? 0;
    const f = num(n.raw['filtered']) ?? 100;
    n.selfCost = rows * outer;
    n.estRows = Math.round((rows * outer * f) / 100);
    for (const c of n.children) examinedRows(c, 1);
    return n.estRows;
  }
  n.selfCost = 0;
  let out = outer;
  for (const c of n.children) out = examinedRows(c, outer);
  return out;
}

function finish(plan: Plan): Plan {
  const pg = plan.engine === 'postgres';
  computeSelf(plan.root, pg);
  if (plan.analyzed) {
    plan.total = plan.root.totalMs ?? plan.executionMs ?? 0;
    if (!plan.executionMs) plan.executionMs = plan.total;
  } else plan.total = plan.root.cost ?? 0;
  if (!plan.total) {
    // aucune mesure : repli sur le coût
    plan.metric = 'cost';
    plan.total = plan.root.cost ?? 0;
  }
  if (!plan.total && !pg) {
    // MariaDB n'indique pas de coût : on compare les lignes examinées estimées
    plan.metric = 'rows';
    examinedRows(plan.root, 1);
    walk(plan.root, (n) => (plan.total += n.selfCost ?? 0));
  }
  diagnose(plan);
  return plan;
}

/** Valeur de la métrique propre d'un nœud et part du total (0..1) */
export function share(plan: Plan, n: PlanNode): { value: number; ratio: number } {
  const value = plan.metric === 'time' ? (n.selfMs ?? 0) : (n.selfCost ?? 0);
  return { value, ratio: plan.total ? Math.min(1, value / plan.total) : 0 };
}

/** Requête EXPLAIN à exécuter selon le moteur */
export function explainSql(engine: 'postgres' | 'mysql' | 'mariadb', sql: string, analyze: boolean): { sql: string; format: 'pg-json' | 'my-json' | 'my-tree' } {
  const s = sql.trim().replace(/;\s*$/, '');
  if (engine === 'postgres') return { sql: `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}VERBOSE, FORMAT JSON) ${s}`, format: 'pg-json' };
  if (engine === 'mariadb') return { sql: `${analyze ? 'ANALYZE' : 'EXPLAIN'} FORMAT=JSON ${s}`, format: 'my-json' };
  return analyze ? { sql: `EXPLAIN ANALYZE ${s}`, format: 'my-tree' } : { sql: `EXPLAIN FORMAT=JSON ${s}`, format: 'my-json' };
}

export function parsePlan(format: 'pg-json' | 'my-json' | 'my-tree', engine: 'postgres' | 'mysql' | 'mariadb', output: string): Plan {
  if (format === 'pg-json') return parsePgPlan(output);
  if (format === 'my-tree') return parseMysqlTree(output);
  return parseMysqlJson(output, engine === 'mariadb' ? 'mariadb' : 'mysql');
}

/** Instruction qui modifie des données (EXPLAIN ANALYZE l'exécute réellement) */
export function isWriteStatement(sql: string): boolean {
  const s = sql.replace(/^\s*(--[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*/g, '');
  if (/^(insert|update|delete|merge|replace|create|alter|drop|truncate|call|do)\b/i.test(s)) return true;
  // WITH … INSERT/UPDATE/DELETE
  return /^with\b/i.test(s) && /\b(insert\s+into|update\s+\S+\s+set|delete\s+from)\b/i.test(s);
}
