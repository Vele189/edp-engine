import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum } from 'd3-force';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { newId } from '../engine/engine';
import {
  NOTE_KINDS,
  RELATIONS,
  allNodes,
  clusters as findClusters,
  createNote,
  degree,
  deleteNote,
  describeEdge,
  edgesOf,
  link,
  nodeOf,
  search,
  unlink,
  updateNote,
  type GraphNode,
} from '../engine/graph';
import type { Db, NoteKind, Relation } from '../engine/types';
import { useStore } from '../store';
import { AutoText, Problems, useUi } from '../components/ui';

type Pos = { x: number; y: number };
interface SimNode extends SimulationNodeDatum {
  id: string;
}

/**
 * Force layout that keeps existing nodes where they were: only new nodes need to find a place,
 * so adding an idea never reshuffles the whole map. Deterministic for the same input.
 */
function layout(db: Db, nodes: GraphNode[], prev: Map<string, Pos>): Map<string, Pos> {
  const ids = new Set(nodes.map((n) => n.id));
  const links = db.links.filter((l) => ids.has(l.a) && ids.has(l.b));
  const sim: SimNode[] = nodes.map((n) => ({ id: n.id, ...prev.get(n.id) }));
  const byId = new Map(sim.map((s) => [s.id, s]));
  let seeded = 0;
  for (const s of sim) {
    if (s.x !== undefined) continue;
    const l = links.find((x) => (x.a === s.id || x.b === s.id) && prev.has(x.a === s.id ? x.b : x.a));
    if (l) {
      const p = prev.get(l.a === s.id ? l.b : l.a)!;
      s.x = p.x + 18 * Math.cos(seeded);
      s.y = p.y + 18 * Math.sin(seeded);
    }
    seeded++;
  }
  const settled = prev.size > 0 && seeded <= Math.max(3, nodes.length * 0.2);
  const simulation = forceSimulation(sim)
    .force(
      'link',
      forceLink(links.map((l) => ({ source: l.a, target: l.b })))
        .id((d) => (d as SimNode).id)
        .distance(95)
        .strength(0.7),
    )
    .force('charge', forceManyBody().strength(-380))
    .force('x', forceX(0).strength(0.05))
    .force('y', forceY(0).strength(0.05))
    .force('collide', forceCollide(36))
    .stop();
  if (settled) simulation.alpha(0.25);
  simulation.tick(settled ? 120 : 300);
  return new Map([...byId].map(([id, s]) => [id, { x: s.x!, y: s.y! }]));
}

const radius = (deg: number) => Math.min(18, 7 + 2.2 * Math.sqrt(deg));
/** Folder-linked projects are the brain's parent nodes: always the largest. */
const nodeRadius = (n: GraphNode, deg: number) => (n.folder ? 21 : radius(deg));

export function Graph({ focus }: { focus?: string }) {
  const { db } = useStore();
  const { openProject } = useUi();
  const [showFrozen, setShowFrozen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(focus ?? null);
  const [hover, setHover] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const positions = useRef(new Map<string, Pos>());

  const nodes = useMemo(() => allNodes(db, showFrozen), [db, showFrozen]);
  const ids = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const links = useMemo(() => db.links.filter((l) => ids.has(l.a) && ids.has(l.b)), [db.links, ids]);
  const structure = nodes.map((n) => n.id).join() + '|' + links.map((l) => l.a + l.b).join();
  const pos = useMemo(() => {
    positions.current = layout(db, nodes, positions.current);
    return positions.current;
    // Re-layout only when the set of nodes or links changes, not on every text edit.
  }, [structure]);
  const { clusters, orphans } = useMemo(() => findClusters(db, showFrozen), [db, showFrozen]);
  const hubs = new Set(clusters.map((c) => c.hub.id));
  const matches = useMemo(() => new Set(query.trim() ? search(db, query, 50, showFrozen).map((r) => r.node.id) : []), [db, query, showFrozen]);

  useEffect(() => {
    if (focus) setSelected(focus);
  }, [focus]);
  useEffect(() => {
    if (selected && !nodeOf(db, selected)) setSelected(null);
  }, [db, selected]);

  const active = hover ?? selected;
  const neighbors = useMemo(() => {
    if (!active) return null;
    const s = new Set([active]);
    for (const l of links) {
      if (l.a === active) s.add(l.b);
      if (l.b === active) s.add(l.a);
    }
    return s;
  }, [active, links]);

  const selectedNode = selected ? nodeOf(db, selected) : undefined;

  return (
    <div className="stack">
      <div className="graph-controls">
        <input
          className="graph-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find in the brain"
          aria-label="Find in the brain"
        />
        <label className="inline toggle">
          <input type="checkbox" role="switch" checked={showFrozen} onChange={(e) => setShowFrozen(e.target.checked)} />
          <span>Show frozen</span>
        </label>
        <button
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
        >
          New note
        </button>
        <Legend />
      </div>

      <div className="graph-layout">
        <GraphCanvas
          nodes={nodes}
          links={links}
          pos={pos}
          db={db}
          hubs={hubs}
          neighbors={neighbors}
          matches={matches}
          selected={selected}
          hover={hover}
          onHover={setHover}
          onSelect={(id) => {
            setSelected(id);
            setCreating(false);
          }}
        />
        <aside className="graph-panel panel">
          {creating ? (
            <NewNote
              onDone={(id) => {
                setCreating(false);
                if (id) setSelected(id);
              }}
            />
          ) : selectedNode ? (
            <NodePanel key={selectedNode.id} node={selectedNode} onSelect={setSelected} onOpenProject={openProject} />
          ) : (
            <div className="muted">
              <p>
                <strong className="ink">{nodes.length} nodes</strong> · {links.length} links · {clusters.length} groups
              </p>
              <p className="small">Select a node to see what it connects to and why. Claude links nodes as you talk; you can add or remove links here too.</p>
            </div>
          )}
        </aside>
      </div>

      <section className="panel">
        <header className="panel-head">
          <h2>Groups</h2>
        </header>
        {clusters.length === 0 && <p className="muted small">No groups yet: groups form as nodes get linked.</p>}
        {clusters.map((c) => (
          <div key={c.hub.id} className="group-row">
            <button className="link" onClick={() => setSelected(c.hub.id)}>
              {c.hub.title}
            </button>
            <span className="muted small"> · {c.members.length} nodes</span>
            <div className="chips">
              {c.members
                .filter((m) => m.id !== c.hub.id)
                .map((m) => (
                  <button key={m.id} className={`chip ${m.kind}`} onClick={() => setSelected(m.id)}>
                    {m.title}
                  </button>
                ))}
            </div>
          </div>
        ))}
        {orphans.length > 0 && (
          <div className="group-row">
            <span className="label">Unlinked ({orphans.length})</span>
            <div className="chips">
              {orphans.map((m) => (
                <button key={m.id} className={`chip ${m.kind}`} onClick={() => setSelected(m.id)}>
                  {m.title}
                </button>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function Legend() {
  return (
    <div className="legend" aria-label="Legend">
      <span>
        <svg width="12" height="12" aria-hidden="true">
          <circle cx="6" cy="6" r="5" className="g-project" />
        </svg>
        Project
      </span>
      <span>
        <svg width="12" height="12" aria-hidden="true">
          <rect x="1" y="1" width="10" height="10" rx="3" className="g-note" />
        </svg>
        Note
      </span>
      <span>
        <svg width="16" height="16" aria-hidden="true">
          <circle cx="8" cy="8" r="7" className="g-parent-ring" />
          <circle cx="8" cy="8" r="4.5" className="g-project" />
        </svg>
        Project folder (parent)
      </span>
    </div>
  );
}

interface CanvasProps {
  nodes: GraphNode[];
  links: Db['links'];
  pos: Map<string, Pos>;
  db: Db;
  hubs: Set<string>;
  neighbors: Set<string> | null;
  matches: Set<string>;
  selected: string | null;
  hover: string | null;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

function GraphCanvas({ nodes, links, pos, db, hubs, neighbors, matches, selected, hover, onHover, onSelect }: CanvasProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  // Unknown until the canvas is measured; the first fit waits for the real size.
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const fitted = useRef(false);

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = () => {
    if (!pos.size) return setView({ x: 0, y: 0, k: 1 });
    const xs = [...pos.values()].map((p) => p.x);
    const ys = [...pos.values()].map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // Leave room for labels (they extend sideways and below the node).
    const padX = Math.min(180, size.w * 0.3);
    const padY = Math.min(100, size.h * 0.15);
    const k = Math.min(1.6, (size.w - padX) / Math.max(1, maxX - minX), (size.h - padY) / Math.max(1, maxY - minY));
    setView({ x: -((minX + maxX) / 2) * k, y: -((minY + maxY) / 2) * k, k: Math.max(0.3, k) });
  };

  useEffect(() => {
    if (!fitted.current && size.w > 0 && pos.size) {
      fitted.current = true;
      fit();
    }
  }, [size, pos]);

  // Wheel zoom around the pointer; non-passive so the page doesn't scroll instead.
  useEffect(() => {
    const el = svg.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const px = e.clientX - r.left - size.w / 2;
      const py = e.clientY - r.top - size.h / 2;
      setView((v) => {
        const k = Math.min(4, Math.max(0.25, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [size]);

  const zoomBy = (f: number) => setView((v) => ({ k: Math.min(4, Math.max(0.25, v.k * f)), x: v.x * f, y: v.y * f }));

  const onDown = (e: RPointerEvent) => {
    if ((e.target as Element).closest('.g-node')) return;
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (d) setView((v) => ({ ...v, x: d.vx + e.clientX - d.x, y: d.vy + e.clientY - d.y }));
  };
  const onUp = () => (drag.current = null);

  const dim = (id: string) => (neighbors ? !neighbors.has(id) : matches.size > 0 && !matches.has(id));
  // Labels are placed greedily by priority and skipped when they would collide with one already placed.
  // Hidden labels stay reachable through hover, the panel and the Groups list.
  const labelled = useMemo(() => {
    const focus = hover ?? selected;
    const rank = (n: GraphNode) =>
      (n.id === focus ? 1e6 : 0) + (neighbors?.has(n.id) ? 1e5 : 0) + (matches.has(n.id) ? 1e4 : 0) + (hubs.has(n.id) || n.folder ? 1e3 : 0) + degree(db, n.id);
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    const out = new Set<string>();
    for (const n of [...nodes].sort((x, y) => rank(y) - rank(x))) {
      const p = pos.get(n.id);
      if (!p) continue;
      const cx = p.x * view.k;
      const top = p.y * view.k + nodeRadius(n, degree(db, n.id)) * view.k + 2;
      const half = (Math.min(n.title.length, 28) * 7.2) / 2 + 4;
      const box = { l: cx - half, r: cx + half, t: top, b: top + 16 };
      const left = size.w / 2 + view.x + box.l;
      const right = size.w / 2 + view.x + box.r;
      if (n.id !== focus && (left < 2 || right > size.w - 2)) continue;
      if (placed.some((o) => box.l < o.r && o.l < box.r && box.t < o.b && o.t < box.b)) continue;
      placed.push(box);
      out.add(n.id);
    }
    return out;
  }, [nodes, pos, view, size.w, hover, selected, neighbors, matches, hubs, db]);
  const showLabel = (n: GraphNode) => labelled.has(n.id);
  const tip = hover ? nodeOf(db, hover) : undefined;
  const tipPos = hover && pos.get(hover);

  return (
    <div className="graph-canvas" ref={wrap}>
      <svg
        ref={svg}
        width={size.w}
        height={size.h}
        role="img"
        aria-label={`Graph of ${nodes.length} nodes and ${links.length} links. The Groups list below has the same information as text.`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <g transform={`translate(${size.w / 2 + view.x},${size.h / 2 + view.y}) scale(${view.k})`}>
          {links.map((l) => {
            const a = pos.get(l.a);
            const b = pos.get(l.b);
            if (!a || !b) return null;
            const on = !!neighbors && (l.a === (hover ?? selected) || l.b === (hover ?? selected));
            return (
              <line
                key={l.id}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={`g-edge${on ? ' on' : ''}${neighbors && !on ? ' dim' : ''}`}
                strokeWidth={(on ? 2 : 1) / view.k}
              />
            );
          })}
          {nodes.map((n) => {
            const p = pos.get(n.id);
            if (!p) return null;
            const r = nodeRadius(n, degree(db, n.id));
            const cls = n.frozen ? 'g-frozen' : n.kind === 'note' ? 'g-note' : 'g-project';
            return (
              <g
                key={n.id}
                className={`g-node${dim(n.id) ? ' dim' : ''}${n.id === selected ? ' selected' : ''}`}
                transform={`translate(${p.x},${p.y})`}
                tabIndex={0}
                role="button"
                aria-label={`${n.title}, ${n.kind === 'note' ? 'note' : 'project'}, ${degree(db, n.id)} links`}
                onPointerEnter={() => onHover(n.id)}
                onPointerLeave={() => onHover(null)}
                onFocus={() => onHover(n.id)}
                onBlur={() => onHover(null)}
                onClick={() => onSelect(n.id)}
                onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onSelect(n.id))}
              >
                <circle r={Math.max(12, r + 6)} className="g-hit" />
                {n.kind === 'note' ? (
                  <rect x={-r} y={-r} width={2 * r} height={2 * r} rx={r * 0.35} className={cls} />
                ) : (
                  <>
                    {n.folder && <circle r={r + 5} className="g-parent-ring" />}
                    <circle r={r} className={cls} />
                  </>
                )}
                {showLabel(n) && (
                  <text y={r + 13 / view.k} className={`g-label${hubs.has(n.id) ? ' hub' : ''}`} style={{ fontSize: `${(hubs.has(n.id) ? 13 : 12) / view.k}px` }}>
                    {n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>

      {tip && tipPos && (
        <div
          className="g-tooltip"
          style={{
            left: Math.min(size.w - 135, Math.max(135, size.w / 2 + view.x + tipPos.x * view.k)),
            top: Math.max(70, size.h / 2 + view.y + tipPos.y * view.k),
          }}
          role="status"
        >
          <strong>{tip.title}</strong>
          <span>
            {tip.kind === 'note' ? `Note · ${tip.subtitle}` : tip.subtitle} · {degree(db, tip.id)} links
          </span>
        </div>
      )}

      <div className="graph-zoom">
        <button className="icon-button" onClick={() => zoomBy(1.3)} aria-label="Zoom in">
          +
        </button>
        <button className="icon-button" onClick={() => zoomBy(1 / 1.3)} aria-label="Zoom out">
          −
        </button>
        <button className="small" onClick={fit}>
          Fit
        </button>
      </div>
      {nodes.length === 0 && <p className="graph-empty muted">The brain is empty. Capture an idea or tell Claude what you're thinking about.</p>}
    </div>
  );
}

function NodePanel({ node, onSelect, onOpenProject }: { node: GraphNode; onSelect: (id: string) => void; onOpenProject: (id: string) => void }) {
  const { db, act } = useStore();
  const note = node.kind === 'note' ? db.notes.find((n) => n.id === node.id) : undefined;
  const edges = edgesOf(db, node.id);
  const [linking, setLinking] = useState(false);

  return (
    <div className="node-panel">
      <p className="eyebrow">{node.kind === 'note' ? `Note · ${node.subtitle}` : `Project · ${node.subtitle}`}</p>
      {note ? (
        <>
          <AutoText singleLine className="node-title" value={note.title} aria-label="Title" onChange={(v) => act((d, n) => updateNote(d, note.id, { title: v }, n))} />
          <select value={note.kind} aria-label="Kind" onChange={(e) => act((d, n) => updateNote(d, note.id, { kind: e.target.value as NoteKind }, n))}>
            {Object.entries(NOTE_KINDS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <AutoText value={note.body} aria-label="Note" placeholder="What's worth remembering" onChange={(v) => act((d, n) => updateNote(d, note.id, { body: v }, n))} />
          <p className="muted small">From {note.source === 'chat' ? 'a chat with Claude' : 'the app'} · {note.createdAt.slice(0, 10)}</p>
        </>
      ) : (
        <>
          <h2>{node.title}</h2>
          {node.text && <p className="node-text">{node.text}</p>}
          <button className="small" onClick={() => onOpenProject(node.id)}>
            Open project
          </button>
        </>
      )}

      <h3>Connections ({edges.length})</h3>
      {edges.length === 0 && <p className="muted small">Not linked to anything yet.</p>}
      <ul className="edges">
        {edges.map((e) => (
          <li key={e.link.id}>
            <button className="link" onClick={() => onSelect(e.other.id)}>
              {describeEdge(e)}
            </button>
            <p className="muted small">
              {e.link.why}
              {e.link.by === 'user' ? ' · by you' : ' · by Claude'}
            </p>
            <button className="plain small" onClick={() => act((d) => unlink(d, e.link.a, e.link.b))}>
              Unlink
            </button>
          </li>
        ))}
      </ul>

      <div className="actions left">
        <a className="button-link small" href={`#board:${node.id}`}>
          Open board
        </a>
        {!linking && (
          <button className="small" onClick={() => setLinking(true)}>
            Link to…
          </button>
        )}
      </div>
      {linking && <LinkForm from={node.id} onDone={() => setLinking(false)} />}
      {note && (
        <div className="actions left">
          <button
            className="plain small danger"
            onClick={() => confirm(`Delete the note "${note.title}" and its ${edges.length} link(s)?`) && act((d) => deleteNote(d, note.id))}
          >
            Delete note
          </button>
        </div>
      )}
    </div>
  );
}

function LinkForm({ from, onDone }: { from: string; onDone: () => void }) {
  const { db, act } = useStore();
  const [q, setQ] = useState('');
  const [to, setTo] = useState<GraphNode | null>(null);
  const [relation, setRelation] = useState<Relation>('same-theme');
  const [why, setWhy] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const linked = new Set(edgesOf(db, from).map((e) => e.other.id));
  const results = search(db, q, 8).filter((r) => r.node.id !== from && !linked.has(r.node.id));

  if (!to) {
    return (
      <div className="link-form">
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a node to link" aria-label="Find a node to link" />
        <ul className="plain">
          {results.map(({ node }) => (
            <li key={node.id}>
              <button className="link small-link" onClick={() => setTo(node)}>
                {node.title} <span className="muted">· {node.kind}</span>
              </button>
            </li>
          ))}
        </ul>
        <button className="plain small" onClick={onDone}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <form
      className="link-form"
      onSubmit={(e) => {
        e.preventDefault();
        const errs = act((d, n) => link(d, from, to.id, relation, why, 'user', n));
        setProblems(errs);
        if (!errs.length) onDone();
      }}
    >
      <label>
        <span>This node…</span>
        <select value={relation} onChange={(e) => setRelation(e.target.value as Relation)}>
          {Object.entries(RELATIONS).map(([k, v]) => (
            <option key={k} value={k}>
              {v} {to.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Why do they communicate?</span>
        <AutoText singleLine autoFocus value={why} onChange={(v) => setWhy(v)} placeholder="One sentence" />
      </label>
      <Problems items={problems} />
      <div className="actions left">
        <button className="primary small" type="submit">
          Link
        </button>
        <button className="plain small" type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function NewNote({ onDone }: { onDone: (id?: string) => void }) {
  const { act } = useStore();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<NoteKind>('context');
  const [problems, setProblems] = useState<string[]>([]);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const id = newId();
        const errs = act((d, n) => createNote(d, { title, body, kind, source: 'app' }, n, id));
        setProblems(errs);
        if (!errs.length) onDone(id);
      }}
    >
      <h2>New note</h2>
      <p className="muted small">Context worth remembering. Notes never become tasks.</p>
      <label>
        <span>Title</span>
        <AutoText singleLine autoFocus value={title} onChange={(v) => setTitle(v)} />
      </label>
      <label>
        <span>Kind</span>
        <select value={kind} onChange={(e) => setKind(e.target.value as NoteKind)}>
          {Object.entries(NOTE_KINDS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Note</span>
        <AutoText value={body} onChange={(v) => setBody(v)} />
      </label>
      <Problems items={problems} />
      <div className="actions left">
        <button className="primary" type="submit">
          Save note
        </button>
        <button className="plain" type="button" onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </form>
  );
}
