import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as E from '../src/engine/engine';
import * as G from '../src/engine/graph';
import type { Capacity, Db, MechanismKey, NextAction, NoteKind, Project, Relation, State } from '../src/engine/types';
import { DB_PATH, mutate, read } from './fileStore';
import { addPending, boardText, readBoard } from './boards';
import { expandHome, folderContext, listFolders, projectDir, safeDir } from './workspace';

const INSTRUCTIONS = `EDP Engine is the user's personal operating system for creative continuity (capture ideas, protect commitments, reduce restart friction, keep room for exploration). You operate it on the user's behalf while chatting; changes appear live in their web app.

How to use it:
- At the start of a conversation about work, plans or how the day is going, call edp_overview first and adapt to what it shows (running session, today's intent, deadlines, failure signals).
- When the user mentions a new idea or obligation in passing, capture it with edp_capture. Do not sort or promote it in the moment; confirm in one short line.
- Never promote to Active without edp_firewall. Ask the four gate questions conversationally (reality, evidence, cost, exit). Do not invent gate answers, outcomes or next actions; derive them from what the user said, and ask when something is missing.
- A next action must be concrete: verb + specific object + location + done condition (e.g. Open / poster.fig / Figma / headline sits above portrait).
- When the user starts working, start a session. When they stop, switch or get pulled away, close it with what changed and a fresh next action (leave a beacon). Pausing needs a reason and a complete re-entry card.
- When the user is stuck or can't choose, ask their capacity (low/medium/high) and use edp_route; offer the randomizer if they still can't choose.
- Before high-capacity work, briefly check deadlines, food, sleep and a stopping point. If the day has collapsed, use recovery mode: protect urgent anchors and pick one minimum viable action.
- Guardrails: keep engine overhead low (too much tracking becomes a second job). Treat misses as information about scope, cues, capacity or friction, never as character verdicts. The three-project studio limit is a default constraint; use an explicit swap or a written coexistence reason.
- Projects can be referenced by id, id prefix, or (unique part of) title.

The brain (graph):
- Every project and every note is a node. Notes hold non-actionable context (insights, decisions, references, people, themes, conversation context); they never become obligations. Use edp_capture for things the user might do, edp_note for things worth remembering.
- When the user shares meaningful thinking (why something matters, a decision, a connection they see, a constraint), store it as a short note in their words, not a transcript. Skip small talk.
- Before creating a node, call edp_graph_search with its gist to find related nodes and avoid duplicates; update an existing note instead of duplicating it.
- Link only when two nodes genuinely communicate: one is part of or depends on the other, they compete for the same time or money, one supports, inspired or gives context to the other, or they share a real theme. Never link on keyword overlap alone. Every link needs a one-sentence why.
- Prefer a few strong links over many weak ones; don't turn one node into a hub for everything. If unsure, ask the user or leave it unlinked: orphans are fine.
- Use edp_graph_node to recall context about a project before helping with it, and edp_graph_overview to see the groups.
- Projects can live in folders under the user's workspace root (their projects folder). Before helping with a project, call edp_project_context to learn where it lives and what's planned for it, then read the code yourself with your own file tools at that path. The engine itself never writes into project folders. When the user starts something new in a folder, capture it with that folder (or link an existing project with edp_update_project folder).
- Long or visual material (a plan, a breakdown, a flow) belongs on the node's board via edp_board, not crammed into a note body: one sticky per section in the user's words, headings for structure, and Mermaid for flows. Read a board back with edp_board before adding to it.`;

const server = new McpServer({ name: 'edp-engine', version: '0.3.0' }, { instructions: INSTRUCTIONS });

// ---------- formatting ----------

const sid = (p: Project) => p.id.slice(0, 8);

function line(p: Project, now: Date): string {
  const bits = [`[${sid(p)}] ${p.title}`, `${p.state}/${p.layer}`];
  if (p.deadline) {
    const d = E.daysUntil(p.deadline, now);
    bits.push(`due ${p.deadline} (${d < 0 ? 'OVERDUE' : `${d}d`})`);
  }
  if (p.coexist) bits.push(`coexisting: ${p.coexist}`);
  let out = `- ${bits.join(' · ')}`;
  if (p.state === 'active' || p.state === 'paused') out += `\n    NEXT (${p.card.next.energy}): ${E.formatNext(p.card.next)}`;
  else if (p.why) out += `\n    why: ${p.why}`;
  return out;
}

const lines = (ps: Project[], now: Date, empty = '  (none)') => (ps.length ? ps.map((p) => line(p, now)).join('\n') : empty);

function detail(db: Db, p: Project, now: Date): string {
  const c = p.card;
  const out = [
    line(p, now),
    `id: ${p.id}`,
    `why: ${p.why || '—'}`,
    `created: ${p.createdAt.slice(0, 10)} · updated: ${p.updatedAt.slice(0, 16).replace('T', ' ')}`,
    '',
    'RE-ENTRY CARD',
    `  outcome: ${c.outcome || '—'}`,
    `  current state: ${c.currentState || '—'}`,
    `  next: ${E.formatNext(c.next)} (energy ${c.next.energy})`,
    `  files: ${c.files.join(', ') || '—'}`,
    `  last thought: ${c.lastThought || '—'}`,
    `  blocker: ${c.blocker || '—'}`,
    `  definition of done: ${c.definitionOfDone || '—'}`,
  ];
  if (p.experiment) {
    out.push('', `EXPERIMENT: ${p.experiment.question} (cap ${p.experiment.timeCapMin}m, started ${p.experiment.startedAt.slice(0, 10)})`);
    if (p.experiment.result) out.push(`  result: ${p.experiment.result}`);
  }
  if (p.state === 'cooling') out.push('', `Cooling for ${Math.floor(E.hoursCooling(p, now))}h (cool-down ${db.settings.coolDownHours}h).`);
  if (p.firewall) {
    const f = p.firewall;
    out.push('', `FIREWALL (${f.decision}, ${f.at.slice(0, 10)})`, `  reality: ${f.reality}`, `  evidence: ${f.evidence}`, `  cost: ${f.cost}`, `  exit: ${f.exit}`);
  }
  if (p.completion) out.push('', `COMPLETED: ${p.completion}`);
  const sessions = db.sessions.filter((s) => s.projectId === p.id).slice(-5);
  if (sessions.length) {
    out.push('', 'RECENT SESSIONS');
    for (const s of sessions) {
      out.push(`  ${s.startedAt.slice(0, 16).replace('T', ' ')} · ${s.plannedMin}m ${s.capacity}${s.endedAt ? '' : ' (RUNNING)'}${s.output ? ` · ${s.output}` : ''}`);
    }
  }
  if (p.history.length) {
    out.push('', 'HISTORY');
    for (const t of p.history.slice(-8)) out.push(`  ${t.at.slice(0, 10)} ${t.from} → ${t.to} (${E.REASON_LABELS[t.reason]})${t.note ? `: ${t.note}` : ''}`);
  }
  return out.join('\n');
}

function resolve(db: Db, ref: string): Project {
  const r = ref.trim().toLowerCase();
  const exact = db.projects.find((p) => p.id === ref || p.title.toLowerCase() === r);
  if (exact) return exact;
  const byId = r.length >= 4 ? db.projects.filter((p) => p.id.startsWith(r)) : [];
  if (byId.length === 1) return byId[0];
  const byTitle = db.projects.filter((p) => p.title.toLowerCase().includes(r));
  // Prefer live work over archived matches.
  const live = byTitle.filter((p) => p.state !== 'archived' && p.state !== 'completed');
  if (live.length === 1) return live[0];
  if (byTitle.length === 1) return byTitle[0];
  const candidates = (live.length ? live : byTitle).slice(0, 8);
  if (!candidates.length) throw new E.EngineError([`No project matches "${ref}".`]);
  throw new E.EngineError([`"${ref}" is ambiguous:\n${candidates.map((p) => `  [${sid(p)}] ${p.title} (${p.state})`).join('\n')}`]);
}

type Result = { content: { type: 'text'; text: string }[]; isError?: boolean };

function run(fn: () => string): Result {
  try {
    return { content: [{ type: 'text', text: fn() }] };
  } catch (e) {
    const msg = e instanceof E.EngineError ? `Blocked by engine rules:\n- ${e.problems.join('\n- ')}` : `Error: ${(e as Error).message}`;
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

/** Mutates by project reference, resolving against the same snapshot being changed. */
function change(ref: string, op: (db: Db, p: Project, now: Date) => Db, describe: (db: Db, p: Project, now: Date) => string) {
  let id = '';
  const snap = mutate((db, now) => {
    const p = resolve(db, ref);
    id = p.id;
    return op(db, p, now);
  });
  return describe(snap.db, E.getProject(snap.db, id), new Date());
}

// ---------- schemas ----------

const capacity = z.enum(['low', 'medium', 'high']);
const state = z.enum(['inbox', 'experiment', 'cooling', 'incubator', 'active', 'paused', 'completed', 'archived']);
const layer = z.enum(['anchor', 'studio', 'garden']);
const reason = z.enum(['evidence', 'capacity', 'deadline', 'outcome', 'release', 'test']);
const projectRef = z.string().describe('Project id, id prefix, or (unique part of) the title');
const nextAction = z
  .object({
    verb: z.string().optional(),
    object: z.string().optional().describe('Specific object, e.g. a file or section'),
    location: z.string().optional().describe('App, folder or place'),
    done: z.string().optional().describe('Observable done condition'),
    energy: capacity.optional().describe('Capacity the action needs'),
  })
  .describe('Next physical action; omitted parts keep their current value');

const mergeNext = (cur: NextAction, n?: z.infer<typeof nextAction>): NextAction => ({
  verb: n?.verb ?? cur.verb,
  object: n?.object ?? cur.object,
  location: n?.location ?? cur.location,
  done: n?.done ?? cur.done,
  energy: n?.energy ?? cur.energy,
});

const relation = z.enum(Object.keys(G.RELATIONS) as [Relation, ...Relation[]]);
const noteKind = z.enum(Object.keys(G.NOTE_KINDS) as [NoteKind, ...NoteKind[]]);
const nodeRef = z.string().describe('Node (project or note) id, id prefix, or (unique part of) the title');
const linkSpec = z.object({
  to: nodeRef,
  relation: relation.describe('Reads as a sentence "<this node> <relation> <to>". E.g. a tool idea inspired-by a reference note means the idea was inspired by the reference.'),
  why: z.string().describe('One sentence: why these two communicate'),
});

/** Resolves any node, project or note, the same way `resolve` does for projects. */
function resolveNode(db: Db, ref: string): G.GraphNode {
  const r = ref.trim().toLowerCase();
  const nodes = G.allNodes(db);
  const exact = nodes.find((n) => n.id === ref || n.title.toLowerCase() === r);
  if (exact) return exact;
  const byId = r.length >= 4 ? nodes.filter((n) => n.id.startsWith(r)) : [];
  if (byId.length === 1) return byId[0];
  const byTitle = nodes.filter((n) => n.title.toLowerCase().includes(r));
  const live = byTitle.filter((n) => !n.frozen);
  if (live.length === 1) return live[0];
  if (byTitle.length === 1) return byTitle[0];
  const candidates = (live.length ? live : byTitle).slice(0, 8);
  if (!candidates.length) throw new E.EngineError([`No node matches "${ref}".`]);
  throw new E.EngineError([`"${ref}" is ambiguous:\n${candidates.map((n) => `  [${n.id.slice(0, 8)}] ${n.title} (${n.kind}: ${n.subtitle})`).join('\n')}`]);
}

function applyLinks(db: Db, from: string, links: z.infer<typeof linkSpec>[] | undefined, now: Date): Db {
  return (links ?? []).reduce((d, l) => G.link(d, from, resolveNode(d, l.to).id, l.relation, l.why, 'claude', now), db);
}

/** Validates a workspace folder for linking: it must exist under the root and not belong to another project. */
function checkFolder(db: Db, folder: string, projectId?: string): string {
  const root = db.settings.workspaceRoot;
  if (!root) throw new E.EngineError(['No workspace root yet. Ask the user for their projects folder and set it with edp_workspace.']);
  try {
    projectDir(root, folder);
  } catch (e) {
    throw new E.EngineError([(e as Error).message]);
  }
  const owner = db.projects.find((p) => p.folder === folder && p.id !== projectId);
  if (owner) throw new E.EngineError([`"${folder}" is already linked to "${owner.title}".`]);
  return folder;
}

const nodeLine = (db: Db, n: G.GraphNode) =>
  `- [${n.id.slice(0, 8)}] ${n.title} · ${n.kind === 'note' ? `note/${n.subtitle}` : n.subtitle} · ${G.degree(db, n.id)} link(s)`;

const snippet = (t: string, max = 160) => (t.length > max ? `${t.slice(0, max - 1)}…` : t);

// ---------- read tools ----------

server.registerTool(
  'edp_overview',
  {
    title: 'Overview',
    description: 'Current state of the engine: running session, today, deadlines, active trio, paused work, garden, inbox, failure signals. Call this first.',
    inputSchema: {},
  },
  () =>
    run(() => {
      const { db } = read();
      const now = new Date();
      const by = (s: State, l?: Project['layer']) => db.projects.filter((p) => p.state === s && (!l || p.layer === l));
      const week = E.pilotWeek(db, now);
      const out = [`EDP Engine · ${now.toDateString()} ${now.toTimeString().slice(0, 5)}${week ? ` · ${week === 3 ? 'pilot complete' : `pilot week ${week}`}` : ''}`];

      const s = E.openSession(db);
      if (s) {
        const p = E.getProject(db, s.projectId);
        const min = Math.round((now.getTime() - new Date(s.startedAt).getTime()) / 60_000);
        out.push(`RUNNING SESSION: [${sid(p)}] ${p.title} · ${min}/${s.plannedMin} min · ${s.capacity} capacity${s.bodyDouble ? ' · body doubling' : ''}${min > s.plannedMin ? ' · PAST TIME BOX (stopping cue)' : ''}${s.resumedQuickly === undefined ? ' · re-entry not yet rated' : ''}`);
      }
      const pit = E.openPitStop(db);
      if (pit) out.push(`RUNNING PIT STOP: ${pit.what} · ${Math.round((now.getTime() - new Date(pit.startedAt).getTime()) / 60_000)}/${pit.plannedMin} min`);

      const today = E.todaysOpen(db, now);
      out.push(today ? `TODAY'S ONE OUTPUT: ${today.intent}` : 'TODAY: daily open not done yet');

      const signals = E.mechanismOn(db, 'failureSignals') ? E.failureSignals(db, now) : [];
      if (signals.length) out.push(`FAILURE SIGNALS:\n${signals.map((x) => `  ! ${x}`).join('\n')}`);

      const urgent = E.urgentAnchors(db, now);
      if (urgent.length) out.push(`PROTECT FIRST:\n${lines(urgent, now)}`);
      out.push(`ANCHORS:\n${lines(by('active', 'anchor'), now)}`);
      out.push(`ACTIVE STUDIO (${E.activeStudio(db).length}/${db.settings.activeLimit}):\n${lines(E.activeStudio(db), now)}`);
      out.push(`PAUSED:\n${lines(by('paused'), now)}`);
      out.push(`EXPERIMENTS:\n${lines(by('experiment'), now)}`);
      out.push(`COOLING (needs firewall):\n${lines(by('cooling'), now)}`);
      out.push(`INCUBATOR: ${by('incubator').map((p) => p.title).join(', ') || '(none)'}`);
      const inbox = by('inbox');
      out.push(`INBOX (${inbox.length}): ${inbox.slice(0, 12).map((p) => `[${sid(p)}] ${p.title}`).join('; ') || '(empty)'}`);
      const last = db.reviews.at(-1);
      out.push(`LAST WEEKLY RESET: ${last ? last.at.slice(0, 10) : 'never'}`);
      return out.join('\n\n');
    }),
);

server.registerTool(
  'edp_list_projects',
  {
    title: 'List projects',
    description: 'List projects, optionally filtered by state, layer, or a text query (searches title, why, card and files; includes the Freezer).',
    inputSchema: { state: state.optional(), layer: layer.optional(), query: z.string().optional() },
  },
  ({ state: st, layer: ly, query }) =>
    run(() => {
      const { db } = read();
      const q = query?.toLowerCase();
      const ps = db.projects.filter(
        (p) =>
          (!st || p.state === st) &&
          (!ly || p.layer === ly) &&
          (!q || [p.title, p.why, p.completion, p.card.outcome, p.card.lastThought, ...p.card.files].some((s) => s?.toLowerCase().includes(q))),
      );
      return `${ps.length} project(s)\n${lines(ps, new Date())}`;
    }),
);

server.registerTool(
  'edp_get_project',
  { title: 'Get project', description: 'Full detail of one project: re-entry card, experiment, firewall answers, sessions, history.', inputSchema: { project: projectRef } },
  ({ project }) =>
    run(() => {
      const { db } = read();
      return detail(db, resolve(db, project), new Date());
    }),
);

// ---------- capture + edit ----------

server.registerTool(
  'edp_capture',
  {
    title: 'Capture',
    description: 'Capture one or more ideas/obligations into the Inbox. No sorting, no promise to execute.',
    inputSchema: {
      items: z
        .array(
          z.object({
            title: z.string(),
            why: z.string().optional().describe('Why it matters'),
            links: z.array(linkSpec).optional().describe('Links from this new node to existing nodes'),
            folder: z.string().optional().describe('Project folder name under the workspace root, if this lives in one'),
          }),
        )
        .min(1),
    },
  },
  ({ items }) =>
    run(() => {
      const ids: string[] = [];
      const snap = mutate((db, now) => {
        let d = db;
        for (const it of items) {
          d = E.capture(d, it.title, it.why ?? '', now);
          const id = d.projects[0].id;
          if (it.folder) d = E.updateProject(d, id, { folder: checkFolder(d, it.folder, id) }, now);
          ids.push(id);
          d = applyLinks(d, id, it.links, now);
        }
        return d;
      });
      const lines = ids.map((id) => {
        const p = E.getProject(snap.db, id);
        const edges = G.edgesOf(snap.db, id).map((e) => `${p.title} ${G.describeEdge(e)}`);
        return `  [${sid(p)}] ${p.title}${edges.length ? `\n      ${edges.join('\n      ')}` : ''}`;
      });
      return `Captured ${ids.length} into Inbox:\n${lines.join('\n')}\nInbox now has ${snap.db.projects.filter((p) => p.state === 'inbox').length}.`;
    }),
);

server.registerTool(
  'edp_update_project',
  {
    title: 'Update project',
    description: 'Edit a project and its re-entry card. Only provided fields change. Use deadline "" to clear it.',
    inputSchema: {
      project: projectRef,
      title: z.string().optional(),
      why: z.string().optional(),
      layer: layer.optional(),
      deadline: z.string().optional().describe('YYYY-MM-DD, or "" to clear'),
      outcome: z.string().optional(),
      current_state: z.string().optional(),
      next: nextAction.optional(),
      last_thought: z.string().optional(),
      blocker: z.string().optional(),
      definition_of_done: z.string().optional(),
      add_files: z.array(z.string()).optional().describe('Paths or URLs of exact files'),
      remove_files: z.array(z.string()).optional(),
      experiment_result: z.string().optional(),
      folder: z.string().optional().describe('Project folder under the workspace root; "" unlinks'),
    },
  },
  (a) =>
    run(() =>
      change(
        a.project,
        (db, p, now) => {
          if (a.deadline && !/^\d{4}-\d{2}-\d{2}$/.test(a.deadline)) throw new E.EngineError(['Deadline must be YYYY-MM-DD.']);
          if (a.experiment_result !== undefined && !p.experiment) throw new E.EngineError(['This project has no experiment.']);
          const c = p.card;
          const files = [...c.files.filter((f) => !a.remove_files?.includes(f)), ...(a.add_files ?? []).filter((f) => !c.files.includes(f))];
          return E.updateProject(
            db,
            p.id,
            {
              title: a.title ?? p.title,
              why: a.why ?? p.why,
              layer: a.layer ?? p.layer,
              deadline: a.deadline === undefined ? p.deadline : a.deadline || undefined,
              experiment: a.experiment_result !== undefined ? { ...p.experiment!, result: a.experiment_result } : p.experiment,
              folder: a.folder === undefined ? p.folder : a.folder ? checkFolder(db, a.folder, p.id) : undefined,
              card: {
                outcome: a.outcome ?? c.outcome,
                currentState: a.current_state ?? c.currentState,
                next: mergeNext(c.next, a.next),
                files,
                lastThought: a.last_thought ?? c.lastThought,
                blocker: a.blocker ?? c.blocker,
                definitionOfDone: a.definition_of_done ?? c.definitionOfDone,
              },
            },
            now,
          );
        },
        (db, p, now) => `Updated.\n${detail(db, p, now)}`,
      ),
    ),
);

server.registerTool(
  'edp_move',
  {
    title: 'Change state',
    description: `Move a project through the state machine (needs a reason). Allowed: ${Object.entries(E.EDGES)
      .map(([f, t]) => `${f}→${t.join('|')}`)
      .join('; ')}. Cooling/incubator→active must go through edp_firewall instead. Experiment needs question + time cap; paused needs note (why) and a complete card; completed needs completion.`,
    inputSchema: {
      project: projectRef,
      to: state,
      reason,
      note: z.string().optional().describe('Required when pausing: why'),
      experiment_question: z.string().optional(),
      time_cap_min: z.number().int().positive().optional(),
      completion: z.string().optional().describe('What shipped or what was learned'),
      coexist: z.string().optional().describe('Why this explicitly coexists when the active trio is full'),
      layer: z.enum(['anchor', 'studio']).optional().describe('Layer when activating something from the garden'),
    },
  },
  (a) =>
    run(() =>
      change(
        a.project,
        (db, p, now) =>
          E.transition(
            db,
            p.id,
            a.to,
            {
              reason: a.reason,
              note: a.note,
              experiment: a.to === 'experiment' ? { question: a.experiment_question ?? '', timeCapMin: a.time_cap_min ?? 0 } : undefined,
              completion: a.completion,
              coexist: a.coexist,
              layer: a.layer,
            },
            now,
          ),
        (_db, p, now) => `Moved.\n${line(p, now)}`,
      ),
    ),
);

server.registerTool(
  'edp_firewall',
  {
    title: 'Commitment firewall',
    description:
      'Run a cooling/incubator project through the four gates, then promote (→ active, needs all gates + outcome + complete next action; may need coexist if trio is full), defer (→ incubator) or decline (→ archive). Gate answers must come from the user.',
    inputSchema: {
      project: projectRef,
      reality: z.string().describe('Gate 1: what existing obligation loses time if this enters?'),
      evidence: z.string().describe('Gate 2: smallest observable result that makes it more credible'),
      cost: z.string().describe('Gate 3: opportunity cost in time, money, maintenance, attention'),
      exit: z.string().describe('Gate 4: what signal means pause, shrink scope, or stop'),
      decision: z.enum(['promote', 'defer', 'decline']),
      layer: z.enum(['anchor', 'studio']).optional().describe('Where to put it when promoting (default studio)'),
      coexist: z.string().optional(),
    },
  },
  (a) =>
    run(() => {
      let warn = '';
      return change(
        a.project,
        (db, p, now) => {
          const cooled = E.hoursCooling(p, now);
          if (a.decision === 'promote' && E.mechanismOn(db, 'coolDown') && p.state === 'cooling' && cooled < db.settings.coolDownHours) {
            warn = ` Note: it only cooled ${Math.floor(cooled)}h of the ${db.settings.coolDownHours}h cool-down.`;
          }
          return E.runFirewall(
            db,
            p.id,
            { reality: a.reality, evidence: a.evidence, cost: a.cost, exit: a.exit },
            a.decision,
            { layer: a.decision === 'promote' ? (a.layer ?? (p.layer === 'anchor' ? 'anchor' : 'studio')) : undefined, coexist: a.coexist },
            now,
          );
        },
        (_db, p, now) => `Firewall: ${a.decision}.${warn}\n${line(p, now)}`,
      );
    }),
);

// ---------- router + sessions ----------

const CAPACITY_HINT: Record<Capacity, string> = {
  low: 'Low: a 5–15 minute re-entry action (asset prep, reference gathering, essential admin). Preparation is not progress.',
  medium: 'Medium: a defined task with visible output (one design iteration, one bug, one section draft).',
  high: 'High: cognitively demanding work, but first check deadlines, meals, sleep and a stopping boundary.',
};

server.registerTool(
  'edp_route',
  {
    title: 'Attention router',
    description: 'Suggest what to work on for the given capacity: urgent anchors first, then active work whose next action fits. randomize=true picks one non-urgent option (for choice paralysis).',
    inputSchema: { capacity, randomize: z.boolean().optional() },
  },
  ({ capacity: cap, randomize }) =>
    run(() => {
      const { db } = read();
      const now = new Date();
      const { urgent, options } = E.route(db, cap, now);
      const out = [CAPACITY_HINT[cap]];
      if (urgent.length) out.push(`PROTECT FIRST:\n${lines(urgent, now)}`);
      out.push(`FITS ${cap.toUpperCase()} (least recently worked first):\n${lines(options, now, '  (nothing fits; lower capacity or set next actions)')}`);
      if (randomize) {
        const pick = E.randomPick(options);
        out.push(pick ? `RANDOMIZER PICK (15 min): [${sid(pick)}] ${pick.title}` : 'Randomizer: nothing to pick from.');
      }
      return out.join('\n\n');
    }),
);

server.registerTool(
  'edp_start_session',
  {
    title: 'Start session',
    description: 'Start a time-boxed work session on an active project. Returns the re-entry card to read (resume contract: read only the card and linked files).',
    inputSchema: {
      project: projectRef,
      capacity,
      minutes: z.number().int().min(5).max(180).default(30),
      body_double: z.boolean().optional(),
    },
  },
  (a) =>
    run(() =>
      change(
        a.project,
        (db, p, now) => E.startSession(db, p.id, a.capacity, a.minutes, now, a.body_double),
        (db, p, now) =>
          `Session started: ${a.minutes} min, ${a.capacity} capacity. Ends ~${new Date(now.getTime() + a.minutes * 60_000).toTimeString().slice(0, 5)}.\n\n${detail(db, p, now)}\n\nAsk afterwards whether they could start within ~60s (edp_rate_reentry).`,
      ),
    ),
);

server.registerTool(
  'edp_rate_reentry',
  {
    title: 'Rate re-entry',
    description: 'Metric 1: record whether real work resumed within about 60 seconds using the re-entry card, for the running session.',
    inputSchema: { quick: z.boolean() },
  },
  ({ quick }) =>
    run(() => {
      mutate((db) => {
        const s = E.openSession(db);
        if (!s) throw new E.EngineError(['No session is running.']);
        return E.markResume(db, s.id, quick);
      });
      return `Recorded: re-entry ${quick ? 'within' : 'not within'} ~60s.`;
    }),
);

server.registerTool(
  'edp_close_session',
  {
    title: 'Close session',
    description:
      'Session close: log what changed, leave a beacon (next action; parts omitted keep the current card values), then continue (starts a new box), rotate (stays active) or pause (needs pause_reason).',
    inputSchema: {
      output: z.string().describe('What changed'),
      output_kind: z.enum(['none', 'shipped', 'tested', 'solved', 'published', 'obligation']).default('none'),
      next: nextAction.optional(),
      blocker: z.string().optional(),
      file: z.string().optional().describe('Exact file to open next time'),
      last_thought: z.string().optional(),
      decision: z.enum(['continue', 'rotate', 'pause']).default('rotate'),
      pause_reason: z.string().optional(),
    },
  },
  (a) =>
    run(() => {
      let projectId = '';
      const snap = mutate((db, now) => {
        const s = E.openSession(db);
        if (!s) throw new E.EngineError(['No session is running.']);
        const p = E.getProject(db, s.projectId);
        projectId = p.id;
        const closed = E.closeSession(
          db,
          s.id,
          {
            output: a.output,
            outputKind: a.output_kind,
            blocker: a.blocker ?? p.card.blocker,
            next: mergeNext(p.card.next, a.next),
            file: a.file,
            lastThought: a.last_thought ?? '',
            decision: a.decision,
            pauseReason: a.pause_reason,
          },
          now,
        );
        return a.decision === 'continue' ? E.startSession(closed, p.id, s.capacity, s.plannedMin, now, s.bodyDouble) : closed;
      });
      const p = E.getProject(snap.db, projectId);
      const s = snap.db.sessions.filter((x) => x.projectId === projectId).at(a.decision === 'continue' ? -2 : -1)!;
      const min = Math.round((new Date(s.endedAt!).getTime() - new Date(s.startedAt).getTime()) / 60_000);
      return `Closed after ${min} min (${a.decision}).${a.decision === 'continue' ? ' New time box started.' : ''}\n${line(p, new Date())}`;
    }),
);

server.registerTool(
  'edp_pit_stop',
  {
    title: 'Pit stop',
    description: 'Low-dopamine pit stop: capped preparation (charge equipment, gather references, prepare workspace). start (≤30 min) or end.',
    inputSchema: {
      action: z.enum(['start', 'end']),
      what: z.string().optional(),
      minutes: z.number().int().min(1).max(30).default(10),
    },
  },
  ({ action, what, minutes }) =>
    run(() => {
      if (action === 'start') {
        mutate((db, now) => E.startPitStop(db, what ?? '', minutes, now));
        return `Pit stop started: ${what || 'Preparation'}, ${minutes} min cap.`;
      }
      const snap = mutate((db, now) => E.endPitStop(db, now));
      const p = snap.db.pitstops.at(-1)!;
      const min = Math.round((new Date(p.endedAt!).getTime() - new Date(p.startedAt).getTime()) / 60_000);
      return `Pit stop done after ${min} min${min > p.plannedMin ? ` (${min - p.plannedMin} over the cap)` : ''}.`;
    }),
);

// ---------- rituals ----------

server.registerTool(
  'edp_daily_open',
  {
    title: 'Daily open',
    description: "Set today's one meaningful output (optionally tied to an active project). Check anchors/deadlines with edp_overview first.",
    inputSchema: { intent: z.string(), project: projectRef.optional() },
  },
  ({ intent, project }) =>
    run(() => {
      const snap = mutate((db, now) => E.setDailyOpen(db, intent, project ? resolve(db, project).id : undefined, now));
      const today = E.todaysOpen(snap.db, new Date())!;
      const p = today.projectId ? E.getProject(snap.db, today.projectId) : undefined;
      return `Today's one output: ${intent}${p ? `\nOpen first: ${p.card.files[0] ?? E.formatNext(p.card.next)}` : ''}`;
    }),
);

server.registerTool(
  'edp_review_queue',
  {
    title: 'Weekly reset queue',
    description: 'Everything the weekly reset needs: deadlines, active trio, stale paused work, experiments, incubator, inbox, and cards missing an outcome or next action.',
    inputSchema: {},
  },
  () =>
    run(() => {
      const { db } = read();
      const now = new Date();
      const by = (s: State) => db.projects.filter((p) => p.state === s);
      const needCards = db.projects.filter(
        (p) => (p.state === 'active' || p.state === 'paused') && (!E.isNextComplete(p.card.next) || !p.card.outcome.trim()),
      );
      const last = db.reviews.at(-1);
      return [
        `WEEKLY RESET (last: ${last ? last.at.slice(0, 10) : 'never'}). Steps: deadlines & misses → active trio → stale work → inbox → re-entry cards → overhead. Save with edp_save_weekly_reset.`,
        `1. DEADLINES:\n${lines(db.projects.filter((p) => p.deadline && (p.state === 'active' || p.state === 'paused')), now)}`,
        `2. ACTIVE STUDIO (${E.activeStudio(db).length}/${db.settings.activeLimit}):\n${lines(E.activeStudio(db), now)}`,
        `3. STALE PAUSED (14d+):\n${lines(E.stalePaused(db, now), now)}\n   EXPERIMENTS:\n${lines(by('experiment'), now)}\n   INCUBATOR (glance, no forced verdict):\n${lines(by('incubator'), now)}`,
        `4. INBOX (${by('inbox').length}):\n${lines(by('inbox'), now)}`,
        `5. CARDS NEEDING WORK:\n${lines(needCards, now)}`,
      ].join('\n\n');
    }),
);

server.registerTool(
  'edp_save_weekly_reset',
  {
    title: 'Save weekly reset',
    description: 'Record the weekly reset: engine overhead minutes, misses (with cause: scope, cues, capacity, friction, other), and a note.',
    inputSchema: {
      overhead_min: z.number().min(0),
      misses: z
        .array(z.object({ what: z.string(), cause: z.enum(['scope', 'cues', 'capacity', 'friction', 'other']), note: z.string().default('') }))
        .default([]),
      note: z.string().default(''),
    },
  },
  ({ overhead_min, misses, note }) =>
    run(() => {
      mutate((db, now) => E.saveWeeklyReview(db, overhead_min, misses, note, now));
      return `Weekly reset saved (${overhead_min} min overhead, ${misses.length} miss(es)).`;
    }),
);

// ---------- measurement + configuration ----------

server.registerTool(
  'edp_metrics',
  {
    title: 'Metrics',
    description: 'Weekly metrics vs the Week-0 baseline: re-entry success, outputs, misses (by cause), overhead, time worked, prep, body doubling, plus mechanism statuses.',
    inputSchema: { weeks: z.number().int().min(1).max(26).default(4) },
  },
  ({ weeks }) =>
    run(() => {
      const { db } = read();
      const start = E.weekStart(new Date());
      const out: string[] = [];
      const b = db.baseline;
      out.push(b ? `BASELINE (week 0): restart ~${b.restartDelayMin}m, outputs ~${b.outputsPerWeek}/wk, misses ~${b.missesPerWeek}/wk, planning displaces execution: ${b.planningDisplaces}` : 'BASELINE: not recorded');
      out.push('week of    | re-entry   | outputs | misses | overhead | worked | prep | body-doubling re-entry');
      for (let i = 0; i < weeks; i++) {
        const s = new Date(start);
        s.setDate(s.getDate() - 7 * i);
        const m = E.weeklyMetrics(db, s);
        const pct = (r: { success: number; total: number }) => (r.total ? `${Math.round((100 * r.success) / r.total)}% of ${r.total}` : '—');
        const causes = Object.entries(m.causes).map(([k, n]) => `${k}:${n}`).join(',');
        out.push(
          `${E.isoDate(s)} | ${pct(m.reentry).padEnd(10)} | ${String(m.outputs).padEnd(7)} | ${m.misses}${causes ? ` (${causes})` : ''} | ${m.overheadMin ?? '—'} | ${(m.minutesWorked / 60).toFixed(1)}h | ${Math.round(m.pitStopMin)}m | with ${pct(m.bodyDouble.with)}, without ${pct(m.bodyDouble.without)}`,
        );
      }
      out.push(
        `MECHANISMS: ${Object.entries(db.settings.mechanisms)
          .map(([k, m]) => `${k}=${m.status}${m.since ? ` (since ${m.since.slice(0, 10)})` : ''}${m.note ? ` "${m.note}"` : ''}`)
          .join('; ')}`,
      );
      return out.join('\n');
    }),
);

server.registerTool(
  'edp_configure',
  {
    title: 'Configure',
    description: `Adjust the engine: active studio limit, cool-down hours, a mechanism status (on/trial/off; keys: ${Object.keys(E.MECHANISMS).join(', ')}), the Week-0 baseline, or start the two-week pilot.`,
    inputSchema: {
      active_limit: z.number().int().min(1).max(10).optional(),
      cool_down_hours: z.number().min(0).optional(),
      mechanism: z
        .object({
          key: z.enum(Object.keys(E.MECHANISMS) as [MechanismKey, ...MechanismKey[]]),
          status: z.enum(['on', 'trial', 'off']),
          note: z.string().optional(),
        })
        .optional(),
      baseline: z
        .object({
          restart_delay_min: z.number().min(0),
          misses_per_week: z.number().min(0),
          outputs_per_week: z.number().min(0),
          planning_displaces: z.enum(['rarely', 'sometimes', 'often']),
        })
        .optional(),
      start_pilot: z.boolean().optional(),
    },
  },
  (a) =>
    run(() => {
      const done: string[] = [];
      mutate((db, now) => {
        let d = db;
        if (a.active_limit !== undefined || a.cool_down_hours !== undefined) {
          d = {
            ...d,
            settings: {
              ...d.settings,
              activeLimit: a.active_limit ?? d.settings.activeLimit,
              coolDownHours: a.cool_down_hours ?? d.settings.coolDownHours,
            },
          };
          done.push(`limit ${d.settings.activeLimit}, cool-down ${d.settings.coolDownHours}h`);
        }
        if (a.mechanism) {
          const m = a.mechanism;
          d = E.setMechanism(d, m.key, m.status, m.note ?? d.settings.mechanisms[m.key].note, now);
          done.push(`${m.key} → ${m.status}`);
        }
        if (a.baseline) {
          const b = a.baseline;
          d = E.setBaseline(d, { restartDelayMin: b.restart_delay_min, missesPerWeek: b.misses_per_week, outputsPerWeek: b.outputs_per_week, planningDisplaces: b.planning_displaces }, now);
          done.push('baseline recorded');
        }
        if (a.start_pilot) {
          if (!d.baseline) throw new E.EngineError(['Record a Week-0 baseline before starting the pilot.']);
          d = { ...d, pilotStartedAt: now.toISOString() };
          done.push('pilot started (week 1: capture + re-entry cards)');
        }
        return d;
      });
      const trials = Object.entries(read().db.settings.mechanisms).filter(([, m]) => m.status === 'trial');
      const warn = trials.length > 1 ? `\nNote: ${trials.length} mechanisms on trial at once; change one major variable at a time.` : '';
      return (done.length ? `Updated: ${done.join('; ')}.` : 'Nothing to change.') + warn;
    }),
);

// ---------- the brain (graph) ----------

server.registerTool(
  'edp_graph_search',
  {
    title: 'Search the brain',
    description:
      'Shortlist nodes (projects and notes) related to a text, ranked by word overlap. Use before creating or linking nodes; then judge which candidates genuinely communicate.',
    inputSchema: { query: z.string(), limit: z.number().int().min(1).max(30).default(10), include_frozen: z.boolean().default(true) },
  },
  ({ query, limit, include_frozen }) =>
    run(() => {
      const { db } = read();
      const hits = G.search(db, query, limit, include_frozen);
      if (!hits.length) return 'No related nodes found.';
      return hits.map(({ node }) => `${nodeLine(db, node)}${node.text ? `\n    ${snippet(node.text.replace(/\n/g, ' · '))}` : ''}`).join('\n');
    }),
);

server.registerTool(
  'edp_graph_node',
  {
    title: 'Recall a node',
    description: 'One node with its full text and every link (relation + why), plus nodes within `depth` hops. Use to recall context before helping with something.',
    inputSchema: { node: nodeRef, depth: z.number().int().min(1).max(3).default(1) },
  },
  ({ node, depth }) =>
    run(() => {
      const { db } = read();
      const n = resolveNode(db, node);
      const out = [`[${n.id.slice(0, 8)}] ${n.title} · ${n.kind === 'note' ? `note/${n.subtitle}` : n.subtitle}`, `id: ${n.id}`];
      if (n.text) out.push('', n.text);
      const edges = G.edgesOf(db, n.id);
      out.push('', `LINKS (${edges.length}):`);
      for (const e of edges) out.push(`  - ${G.describeEdge(e)} [${e.other.id.slice(0, 8)}]: ${e.link.why}${e.link.by === 'user' ? ' (by user)' : ''}`);
      if (depth > 1) {
        const far = G.neighborhood(db, n.id, depth).filter((x) => x.hops > 1);
        if (far.length) out.push('', `FURTHER OUT:`, ...far.map((x) => `  ${x.hops} hops: [${x.node.id.slice(0, 8)}] ${x.node.title}`));
      }
      return out.join('\n');
    }),
);

server.registerTool(
  'edp_graph_overview',
  {
    title: 'Brain overview',
    description: 'The groups that emerge from links (named after their most-connected node), unlinked nodes, and recent nodes that still have no links.',
    inputSchema: { include_frozen: z.boolean().default(false) },
  },
  ({ include_frozen }) =>
    run(() => {
      const { db } = read();
      const { clusters, orphans } = G.clusters(db, include_frozen);
      const out = [`${G.allNodes(db, include_frozen).length} nodes, ${db.links.length} links, ${clusters.length} group(s).`];
      for (const c of clusters) {
        const names = c.members.filter((m) => m.id !== c.hub.id).map((m) => m.title);
        out.push(`GROUP "${c.hub.title}" (${c.members.length}): ${names.slice(0, 12).join(', ')}${names.length > 12 ? ', …' : ''}`);
      }
      const weekAgo = Date.now() - 7 * 86_400_000;
      const recent = orphans.filter((o) => new Date(o.createdAt).getTime() > weekAgo);
      out.push(`UNLINKED (${orphans.length}): ${orphans.slice(0, 15).map((o) => `[${o.id.slice(0, 8)}] ${o.title}`).join('; ') || '(none)'}`);
      if (recent.length) out.push(`New this week and still unlinked: ${recent.map((o) => o.title).join(', ')}. Link them only if they truly relate.`);
      return out.join('\n');
    }),
);

server.registerTool(
  'edp_note',
  {
    title: 'Note',
    description:
      'Create, update, or delete a note: non-actionable context worth remembering (insight, decision, reference, person, theme, conversation context). Notes never enter the inbox. Create can link the note in the same call.',
    inputSchema: {
      action: z.enum(['create', 'update', 'delete']),
      note: nodeRef.optional().describe('Required for update/delete'),
      title: z.string().optional(),
      body: z.string().optional().describe('The highlight in the user’s words; short, not a transcript'),
      kind: noteKind.optional(),
      links: z.array(linkSpec).optional().describe('Create only: links from the new note'),
    },
  },
  (a) =>
    run(() => {
      if (a.action === 'create') {
        const id = E.newId();
        const snap = mutate((db, now) => applyLinks(G.createNote(db, { title: a.title ?? '', body: a.body, kind: a.kind, source: 'chat' }, now, id), id, a.links, now));
        const edges = G.edgesOf(snap.db, id).map((e) => `${a.title} ${G.describeEdge(e)}`);
        return `Noted [${id.slice(0, 8)}] ${a.title}${edges.length ? `\n  ${edges.join('\n  ')}\n(Check each sentence reads true; re-link with edp_link if a direction is backwards.)` : ' (unlinked)'}`;
      }
      if (!a.note) throw new E.EngineError(['Say which note.']);
      let title = '';
      mutate((db, now) => {
        const n = resolveNode(db, a.note!);
        if (n.kind !== 'note') throw new E.EngineError([`"${n.title}" is a project; use edp_update_project or edp_move.`]);
        title = n.title;
        return a.action === 'delete' ? G.deleteNote(db, n.id) : G.updateNote(db, n.id, { title: a.title, body: a.body, kind: a.kind }, now);
      });
      return a.action === 'delete' ? `Deleted note "${title}" and its links.` : `Updated note "${a.title ?? title}".`;
    }),
);

server.registerTool(
  'edp_link',
  {
    title: 'Link nodes',
    description: `Link two nodes (projects or notes) with a relation and a one-sentence why; re-linking a pair replaces its relation. Relations: ${Object.keys(G.RELATIONS).join(', ')}. Reads "from <relation> to".`,
    inputSchema: { from: nodeRef, to: nodeRef, relation, why: z.string() },
  },
  ({ from, to, relation: rel, why }) =>
    run(() => {
      let a = '';
      const snap = mutate((db, now) => {
        const x = resolveNode(db, from);
        a = x.id;
        return G.link(db, x.id, resolveNode(db, to).id, rel, why, 'claude', now);
      });
      const edge = G.edgesOf(snap.db, a).find((e) => e.link.why === why.trim())!;
      return `Linked: ${G.nodeOf(snap.db, a)!.title} ${G.describeEdge(edge)}.`;
    }),
);

server.registerTool(
  'edp_unlink',
  { title: 'Unlink nodes', description: 'Remove the link between two nodes.', inputSchema: { from: nodeRef, to: nodeRef } },
  ({ from, to }) =>
    run(() => {
      mutate((db) => G.unlink(db, resolveNode(db, from).id, resolveNode(db, to).id));
      return 'Unlinked.';
    }),
);

server.registerTool(
  'edp_board',
  {
    title: 'Board',
    description:
      'The FigJam-style board (handwritten canvas) attached to a node. read: everything written on it, top to bottom. add: queue headings, handwritten text, stickies (one per idea or plan section) and Mermaid diagrams; they are drawn below the existing content the next time the board is open in the app.',
    inputSchema: {
      node: nodeRef,
      action: z.enum(['read', 'add']),
      items: z
        .array(
          z.object({
            type: z.enum(['heading', 'text', 'sticky', 'mermaid']),
            text: z.string().describe('For mermaid: the diagram source, e.g. "flowchart TD\n  A --> B"'),
            color: z.enum(['yellow', 'green', 'blue', 'pink', 'orange']).optional().describe('Sticky colour'),
          }),
        )
        .optional(),
    },
  },
  ({ node, action, items }) =>
    run(() => {
      const { db } = read();
      const n = resolveNode(db, node);
      if (action === 'read') {
        const b = readBoard(n.id);
        if (!b) return `"${n.title}" has no board yet.`;
        const lines = boardText(b);
        return `Board for "${n.title}" (${b.elements.filter((e) => !e.isDeleted).length} drawn elements, ${b.pending.length} queued):\n\n${lines.join('\n\n') || '(no text yet)'}`;
      }
      if (!items?.length) throw new E.EngineError(['Nothing to add.']);
      const b = addPending(n.id, items);
      return `Queued ${items.length} item(s) on the board for "${n.title}". They are drawn the next time the board is open (#board:${n.id}). ${b.pending.length} waiting in total.`;
    }),
);

// ---------- workspace (local project folders) ----------

server.registerTool(
  'edp_workspace',
  {
    title: 'Workspace',
    description:
      "The user's projects folder (workspace root). get: the root and every project folder in it, with the engine project each is linked to. set: choose the root (an existing folder in the user's home, e.g. ~/Documents).",
    inputSchema: { action: z.enum(['get', 'set']), root: z.string().optional() },
  },
  ({ action, root }) =>
    run(() => {
      if (action === 'set') {
        if (!root) throw new E.EngineError(['Say which folder.']);
        let dir: string;
        try {
          dir = safeDir(expandHome(root));
        } catch (e) {
          throw new E.EngineError([(e as Error).message]);
        }
        mutate((db) => ({ ...db, settings: { ...db.settings, workspaceRoot: dir } }));
        return `Workspace root set to ${dir}. ${listFolders(dir).length} project folder(s) found.`;
      }
      const { db } = read();
      const r = db.settings.workspaceRoot;
      if (!r) return 'No workspace root yet. Ask the user which folder holds their projects, then set it.';
      const folders = listFolders(r);
      const lines = folders.map((f) => {
        const p = db.projects.find((x) => x.folder === f.folder);
        const linked = p ? `→ [${sid(p)}] ${p.title} (${p.state})` : '→ untracked';
        return `- ${f.folder}/  ${linked}  · touched ${f.modifiedAt.slice(0, 10)}${f.markers.length ? ` · ${f.markers.join(', ')}` : ''}${f.summary ? `\n    ${f.summary}` : ''}`;
      });
      const missing = db.projects.filter((p) => p.folder && !folders.some((f) => f.folder === p.folder));
      if (missing.length) lines.push(`Linked folders that no longer exist: ${missing.map((p) => `${p.title} → ${p.folder}`).join(', ')}`);
      return `Workspace root: ${r}\n${lines.join('\n')}`;
    }),
);

server.registerTool(
  'edp_project_context',
  {
    title: 'Project context',
    description:
      "Where a project lives and what's planned for it: absolute folder path, README, top-level files, recently changed files, git branch and last commit, plus its engine state, beacon, linked notes and board. Use before helping with a project, then read files yourself at the path.",
    inputSchema: { project: projectRef },
  },
  async ({ project }) => {
    try {
      const { db } = read();
      const p = resolve(db, project);
      const out = [detail(db, p, new Date())];
      const board = readBoard(p.id);
      if (board) out.push('', `BOARD (${board.elements.filter((e) => !e.isDeleted).length} elements): ${boardText(board).slice(0, 8).map((t) => t.split('\n')[0]).join(' · ') || '(no text)'}`);
      const root = db.settings.workspaceRoot;
      if (!p.folder) {
        out.push('', root ? `FOLDER: not linked. Folders available: edp_workspace get.` : 'FOLDER: no workspace root set yet.');
      } else if (root) {
        const ctx = await folderContext(root, p.folder);
        out.push(
          '',
          `FOLDER: ${ctx.path}`,
          ctx.git ? `GIT: ${ctx.git.branch} · last commit ${ctx.git.lastCommit}` : 'GIT: not a repository',
          `TOP LEVEL: ${ctx.tree.join('  ')}`,
          `RECENTLY CHANGED:\n${ctx.recent.map((r) => `  ${r.modifiedAt.slice(0, 16).replace('T', ' ')}  ${r.file}`).join('\n')}`,
          ctx.readme ? `README (excerpt):\n${ctx.readme}` : 'README: none',
        );
      }
      return { content: [{ type: 'text' as const, text: out.join('\n') }] };
    } catch (e) {
      const msg = e instanceof E.EngineError ? `Blocked by engine rules:\n- ${e.problems.join('\n- ')}` : `Error: ${(e as Error).message}`;
      return { content: [{ type: 'text' as const, text: msg }], isError: true };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`edp-engine MCP ready (db: ${DB_PATH})`);
