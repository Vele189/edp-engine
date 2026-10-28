import { EngineError, formatNext, newId } from './engine';
import type { Db, Link, Note, NoteKind, Project, Relation } from './types';

/**
 * The brain: every project and every note is a node. Links carry a relation and a reason,
 * and groups emerge from connectivity, not from folders.
 */

export const RELATIONS: Record<Relation, string> = {
  'part-of': 'part of',
  'depends-on': 'depends on',
  supports: 'supports',
  'conflicts-with': 'conflicts with',
  'inspired-by': 'inspired by',
  'same-theme': 'same theme as',
  'context-for': 'context for',
};

export const NOTE_KINDS: Record<NoteKind, string> = {
  context: 'Context',
  insight: 'Insight',
  decision: 'Decision',
  reference: 'Reference',
  person: 'Person',
  theme: 'Theme',
};

export interface GraphNode {
  id: string;
  kind: 'project' | 'note';
  title: string;
  /** State/layer for projects, note kind for notes. */
  subtitle: string;
  /** The text worth reading: a note's body, or a project's why + beacon. */
  text: string;
  /** Frozen projects (completed/archived) stay in the brain but can be hidden. */
  frozen: boolean;
  createdAt: string;
  /** Set for projects linked to a workspace folder: these are the brain's parent nodes. */
  folder?: string;
}

function projectNode(p: Project): GraphNode {
  const text = [p.why, p.card.outcome && `Outcome: ${p.card.outcome}`, (p.state === 'active' || p.state === 'paused') && `NEXT: ${formatNext(p.card.next)}`, p.completion]
    .filter(Boolean)
    .join('\n');
  return {
    id: p.id,
    kind: 'project',
    title: p.title,
    subtitle: `${p.state} · ${p.layer}`,
    text,
    frozen: p.state === 'archived' || p.state === 'completed',
    createdAt: p.createdAt,
    folder: p.folder,
  };
}

function noteNode(n: Note): GraphNode {
  return { id: n.id, kind: 'note', title: n.title, subtitle: NOTE_KINDS[n.kind].toLowerCase(), text: n.body, frozen: false, createdAt: n.createdAt };
}

export function nodeOf(db: Db, id: string): GraphNode | undefined {
  const p = db.projects.find((x) => x.id === id);
  if (p) return projectNode(p);
  const n = db.notes.find((x) => x.id === id);
  return n ? noteNode(n) : undefined;
}

export function allNodes(db: Db, includeFrozen = true): GraphNode[] {
  const nodes = [...db.projects.map(projectNode), ...db.notes.map(noteNode)];
  return includeFrozen ? nodes : nodes.filter((n) => !n.frozen);
}

function requireNode(db: Db, id: string): GraphNode {
  const n = nodeOf(db, id);
  if (!n) throw new EngineError([`No node with id ${id}.`]);
  return n;
}

// ---------- notes ----------

export interface NoteInput {
  title: string;
  body?: string;
  kind?: NoteKind;
  source?: Note['source'];
}

export function createNote(db: Db, input: NoteInput, now: Date, id: string = newId()): Db {
  if (!input.title.trim()) throw new EngineError(['A note needs a title.']);
  const at = now.toISOString();
  const note: Note = {
    id,
    title: input.title.trim(),
    body: input.body?.trim() ?? '',
    kind: input.kind ?? 'context',
    source: input.source ?? 'app',
    createdAt: at,
    updatedAt: at,
  };
  return { ...db, notes: [note, ...db.notes] };
}

export function updateNote(db: Db, id: string, patch: Partial<Pick<Note, 'title' | 'body' | 'kind'>>, now: Date): Db {
  const n = db.notes.find((x) => x.id === id);
  if (!n) throw new EngineError(['Note not found.']);
  if (patch.title !== undefined && !patch.title.trim()) throw new EngineError(['A note needs a title.']);
  return { ...db, notes: db.notes.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: now.toISOString() } : x)) };
}

/** Deleting a note also removes its links. Projects are never deleted, only archived. */
export function deleteNote(db: Db, id: string): Db {
  if (!db.notes.some((x) => x.id === id)) throw new EngineError(['Note not found.']);
  return { ...db, notes: db.notes.filter((x) => x.id !== id), links: db.links.filter((l) => l.a !== id && l.b !== id) };
}

// ---------- links ----------

const samePair = (l: Link, a: string, b: string) => (l.a === a && l.b === b) || (l.a === b && l.b === a);

export function findLink(db: Db, a: string, b: string): Link | undefined {
  return db.links.find((l) => samePair(l, a, b));
}

/** Links two nodes, or re-describes the existing link between them. A reason is mandatory. */
export function link(db: Db, a: string, b: string, relation: Relation, why: string, by: Link['by'], now: Date): Db {
  const problems: string[] = [];
  if (a === b) problems.push('A node cannot link to itself.');
  if (!(relation in RELATIONS)) problems.push(`Unknown relation "${relation}".`);
  if (why.trim().length < 8) problems.push('Say why these two communicate (a short sentence, not a keyword).');
  if (problems.length) throw new EngineError(problems);
  requireNode(db, a);
  requireNode(db, b);
  const existing = findLink(db, a, b);
  const next: Link = { id: existing?.id ?? newId(), a, b, relation, why: why.trim(), by, createdAt: existing?.createdAt ?? now.toISOString() };
  return { ...db, links: existing ? db.links.map((l) => (l.id === existing.id ? next : l)) : [...db.links, next] };
}

export function unlink(db: Db, a: string, b: string): Db {
  if (!findLink(db, a, b)) throw new EngineError(['Those two nodes are not linked.']);
  return { ...db, links: db.links.filter((l) => !samePair(l, a, b)) };
}

/** A link phrased from `id`'s side, e.g. "depends on X" or "X depends on this". */
export interface Edge {
  link: Link;
  other: GraphNode;
  /** True when `id` is the link's `a`, so the relation reads "this <relation> other". */
  outgoing: boolean;
}

export function edgesOf(db: Db, id: string): Edge[] {
  return db.links
    .filter((l) => l.a === id || l.b === id)
    .map((l) => ({ link: l, other: nodeOf(db, l.a === id ? l.b : l.a)!, outgoing: l.a === id }))
    .filter((e) => e.other);
}

export function describeEdge(e: Edge): string {
  const rel = RELATIONS[e.link.relation];
  return e.outgoing ? `${rel} ${e.other.title}` : `${e.other.title} ${rel} this`;
}

/** Nodes within `depth` hops, nearest first. */
export function neighborhood(db: Db, id: string, depth = 1): { node: GraphNode; hops: number }[] {
  requireNode(db, id);
  const seen = new Map<string, number>([[id, 0]]);
  let frontier = [id];
  for (let d = 1; d <= depth; d++) {
    const next: string[] = [];
    for (const cur of frontier) {
      for (const e of edgesOf(db, cur)) {
        if (!seen.has(e.other.id)) {
          seen.set(e.other.id, d);
          next.push(e.other.id);
        }
      }
    }
    frontier = next;
  }
  seen.delete(id);
  return [...seen].map(([nid, hops]) => ({ node: nodeOf(db, nid)!, hops })).sort((x, y) => x.hops - y.hops);
}

// ---------- groups ----------

export interface Cluster {
  /** The most-connected node; its title names the group. */
  hub: GraphNode;
  members: GraphNode[];
}

export function degree(db: Db, id: string): number {
  return db.links.reduce((n, l) => n + (l.a === id || l.b === id ? 1 : 0), 0);
}

/** Connected components of linked nodes (largest first), plus nodes with no links. */
export function clusters(db: Db, includeFrozen = true): { clusters: Cluster[]; orphans: GraphNode[] } {
  const nodes = allNodes(db, includeFrozen);
  const ids = new Set(nodes.map((n) => n.id));
  const parent = new Map(nodes.map((n) => [n.id, n.id]));
  const find = (x: string): string => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)!)!);
      x = parent.get(x)!;
    }
    return x;
  };
  for (const l of db.links) if (ids.has(l.a) && ids.has(l.b)) parent.set(find(l.a), find(l.b));

  const groups = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const r = find(n.id);
    groups.set(r, [...(groups.get(r) ?? []), n]);
  }
  const out: Cluster[] = [];
  const orphans: GraphNode[] = [];
  for (const members of groups.values()) {
    if (members.length === 1) {
      orphans.push(members[0]);
      continue;
    }
    // A project with a folder is the natural parent of everything planned around it.
    const hub = [...members].sort(
      (x, y) => Number(!!y.folder) - Number(!!x.folder) || degree(db, y.id) - degree(db, x.id) || x.createdAt.localeCompare(y.createdAt),
    )[0];
    out.push({ hub, members });
  }
  return { clusters: out.sort((x, y) => y.members.length - x.members.length), orphans };
}

// ---------- search ----------

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [];
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'about', 'when', 'what', 'have', 'are', 'was', 'not', 'but', 'you', 'our', 'its']);

/**
 * Candidate nodes for a text, ranked by word overlap (title weighs most).
 * Only a shortlist: whether two nodes truly communicate is a judgment, not a score.
 */
export function search(db: Db, query: string, limit = 10, includeFrozen = true): { node: GraphNode; score: number }[] {
  const q = new Set(words(query).filter((w) => !STOP.has(w)));
  if (!q.size) return [];
  return allNodes(db, includeFrozen)
    .map((node) => {
      const title = words(node.title);
      const text = words(node.text);
      let score = 0;
      for (const w of q) {
        if (title.some((t) => t.startsWith(w) || w.startsWith(t))) score += 3;
        if (text.includes(w)) score += 1;
      }
      return { node, score };
    })
    .filter((r) => r.score > 0)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
}
