import type {
  Capacity,
  Db,
  FirewallReview,
  Layer,
  Mechanism,
  MechanismKey,
  MechanismStatus,
  Miss,
  MissCause,
  NextAction,
  OutputKind,
  Project,
  ReasonKind,
  ReentryCard,
  Baseline,
  Session,
  State,
} from './types';

/** Thrown when an operation would break an engine rule; `problems` are user-facing. */
export class EngineError extends Error {
  constructor(public problems: string[]) {
    super(problems.join(' '));
  }
}

/** Allowed state changes, from the "Project States" diagram. */
export const EDGES: Record<State, State[]> = {
  inbox: ['experiment', 'cooling', 'archived'],
  experiment: ['cooling', 'archived'],
  cooling: ['active', 'incubator', 'archived'],
  incubator: ['active', 'cooling', 'archived'],
  active: ['paused', 'completed', 'archived'],
  paused: ['active', 'archived'],
  completed: ['archived'],
  archived: ['active', 'cooling'],
};

export const CAPACITY_RANK: Record<Capacity, number> = { low: 0, medium: 1, high: 2 };

export const REASON_LABELS: Record<ReasonKind, string> = {
  evidence: 'New evidence',
  capacity: 'Changed capacity',
  deadline: 'Deadline',
  outcome: 'Completed outcome',
  release: 'Explicit release',
  test: 'Low-cost test',
};

const DAY = 86_400_000;

export const newId = () => crypto.randomUUID();

export function emptyCard(): ReentryCard {
  return {
    outcome: '',
    currentState: '',
    next: { verb: '', object: '', location: '', done: '', energy: 'medium' },
    files: [],
    lastThought: '',
    blocker: '',
    definitionOfDone: '',
  };
}

export const MECHANISMS: Record<MechanismKey, { label: string; help: string; default: MechanismStatus }> = {
  playground: { label: 'Playground', help: 'Shortcuts to current work on Today', default: 'on' },
  randomizer: { label: 'Randomizer', help: 'Random pick when choice paralysis persists', default: 'on' },
  pitStop: { label: 'Low-dopamine pit stop', help: 'Capped preparation timer', default: 'on' },
  bodyDoubling: { label: 'Body doubling', help: 'Mark sessions done alongside someone', default: 'off' },
  notifications: { label: 'Stopping-cue notification', help: 'One notification when a time box ends', default: 'off' },
  hyperfocusGuard: { label: 'Hyperfocus guard', help: 'Basic-needs check before high capacity and on long overruns', default: 'on' },
  coolDown: { label: 'Cool-down warning', help: 'Warn when promoting an idea that has not cooled', default: 'on' },
  failureSignals: { label: 'Failure signals', help: 'Warnings when the engine becomes another project', default: 'on' },
};

export const MISS_CAUSES: Record<MissCause, string> = {
  scope: 'Scope (too big / unclear)',
  cues: 'Cues (forgot / not visible)',
  capacity: 'Capacity (energy, time, health)',
  friction: 'Friction (hard to start)',
  other: 'Other',
};

const defaultMechanisms = () =>
  Object.fromEntries(
    Object.entries(MECHANISMS).map(([k, m]) => [k, { status: m.default, note: '' }]),
  ) as Record<MechanismKey, Mechanism>;

export function emptyDb(): Db {
  return {
    version: 3,
    projects: [],
    sessions: [],
    pitstops: [],
    notes: [],
    links: [],
    reviews: [],
    daily: [],
    settings: { activeLimit: 3, coolDownHours: 24, mechanisms: defaultMechanisms() },
  };
}

/** Upgrades any saved or imported shape to the current Db. */
export function migrate(raw: any): Db {
  const base = emptyDb();
  const settings = { ...base.settings, ...raw.settings };
  settings.mechanisms = { ...base.settings.mechanisms, ...raw.settings?.mechanisms };
  // v1 misses stored the cause as free text.
  const reviews = (raw.reviews ?? []).map((r: any) => ({
    ...r,
    misses: (r.misses ?? []).map((m: any) =>
      m.cause in MISS_CAUSES ? { note: '', ...m } : { what: m.what, cause: 'other', note: m.cause ?? '' },
    ),
  }));
  return { ...base, ...raw, version: 3, settings, reviews, notes: raw.notes ?? [], links: raw.links ?? [] };
}

export function isNextComplete(n: NextAction): boolean {
  return [n.verb, n.object, n.location, n.done].every((s) => s.trim() !== '');
}

export function formatNext(n: NextAction): string {
  if (!isNextComplete(n)) return 'No next physical action yet';
  return `${n.verb} ${n.object} — ${n.location} — done when ${n.done}`;
}

export function getProject(db: Db, id: string): Project {
  const p = db.projects.find((x) => x.id === id);
  if (!p) throw new EngineError(['Project not found.']);
  return p;
}

function replaceProject(db: Db, next: Project): Db {
  return { ...db, projects: db.projects.map((p) => (p.id === next.id ? next : p)) };
}

export function activeStudio(db: Db): Project[] {
  return db.projects.filter((p) => p.layer === 'studio' && p.state === 'active');
}

/** Inbox: one low-friction capture point. Do not sort while the thought is hot. */
export function capture(db: Db, title: string, why: string, now: Date): Db {
  if (!title.trim()) throw new EngineError(['Capture needs at least a title.']);
  const at = now.toISOString();
  const project: Project = {
    id: newId(),
    title: title.trim(),
    why: why.trim(),
    layer: 'garden',
    state: 'inbox',
    createdAt: at,
    updatedAt: at,
    card: emptyCard(),
    history: [],
  };
  return { ...db, projects: [project, ...db.projects] };
}

export function updateProject(
  db: Db,
  id: string,
  patch: Partial<Pick<Project, 'title' | 'why' | 'layer' | 'deadline' | 'card' | 'experiment' | 'coexist' | 'folder'>>,
  now: Date,
): Db {
  const p = getProject(db, id);
  return replaceProject(db, { ...p, ...patch, updatedAt: now.toISOString() });
}

export interface TransitionOpts {
  reason: ReasonKind;
  note?: string;
  experiment?: { question: string; timeCapMin: number };
  /** Explicit coexistence justification when the active trio is full. */
  coexist?: string;
  completion?: string;
  /** Layer to assign when entering active from the garden. */
  layer?: Layer;
}

/** Returns the reasons a transition is blocked (empty when allowed). */
export function checkTransition(db: Db, p: Project, to: State, opts: TransitionOpts): string[] {
  const problems: string[] = [];
  if (!EDGES[p.state].includes(to)) {
    return [`A project cannot move from ${p.state} to ${to}.`];
  }
  if (!opts.reason) problems.push('Every state change needs a reason.');

  if (to === 'experiment') {
    if (!opts.experiment?.question.trim()) problems.push('An experiment needs one learning question.');
    if (!opts.experiment || opts.experiment.timeCapMin <= 0) problems.push('An experiment needs a time cap.');
  }

  if (to === 'active') {
    const layer = opts.layer ?? p.layer;
    if (layer === 'garden') problems.push('Assign it to Anchors or Active Studio before activating.');
    if (!p.card.outcome.trim()) problems.push('Active work needs a desired outcome.');
    if (!isNextComplete(p.card.next)) problems.push('Active work needs a complete next physical action.');
    if ((p.state === 'cooling' || p.state === 'incubator') && p.firewall?.decision !== 'promote') {
      problems.push('Promotion from cooling or the incubator must pass the Commitment Firewall.');
    }
    const full = layer === 'studio' && activeStudio(db).length >= db.settings.activeLimit;
    if (full && !opts.coexist?.trim()) {
      problems.push(
        `The Active Studio already has ${db.settings.activeLimit}. Pause one (swap), or write why this explicitly coexists.`,
      );
    }
  }

  if (to === 'paused') {
    if (!opts.note?.trim()) problems.push('Pausing needs a clear reason.');
    if (!p.card.outcome.trim() || !p.card.currentState.trim()) {
      problems.push('The re-entry card needs an outcome and current state before pausing.');
    }
    if (!isNextComplete(p.card.next)) problems.push('Never leave a cold project without a beacon: fill in the next action.');
  }

  if (to === 'completed' && !opts.completion?.trim()) {
    problems.push('Record what shipped or what was learned.');
  }

  return problems;
}

export function transition(db: Db, id: string, to: State, opts: TransitionOpts, now: Date): Db {
  const p = getProject(db, id);
  const problems = checkTransition(db, p, to, opts);
  if (problems.length) throw new EngineError(problems);
  const at = now.toISOString();
  const next: Project = {
    ...p,
    state: to,
    updatedAt: at,
    history: [...p.history, { from: p.state, to, reason: opts.reason, note: opts.note?.trim() ?? '', at }],
  };
  if (opts.layer) next.layer = opts.layer;
  if (to === 'experiment' && opts.experiment) next.experiment = { ...opts.experiment, startedAt: at };
  if (to === 'active') next.coexist = opts.coexist?.trim() || undefined;
  if (to === 'completed') next.completion = opts.completion!.trim();
  return replaceProject(db, next);
}

export function hoursCooling(p: Project, now: Date): number {
  const entered = [...p.history].reverse().find((t) => t.to === 'cooling');
  const since = entered ? entered.at : p.createdAt;
  return (now.getTime() - new Date(since).getTime()) / 3_600_000;
}

/**
 * Commitment Firewall: four gates, then promote / defer / decline.
 * Promote assigns a layer and activates; defer → incubator; decline → archive.
 */
export function runFirewall(
  db: Db,
  id: string,
  gates: Omit<FirewallReview, 'at' | 'decision'>,
  decision: FirewallReview['decision'],
  opts: { layer?: Layer; coexist?: string },
  now: Date,
): Db {
  const p = getProject(db, id);
  if (p.state !== 'cooling' && p.state !== 'incubator') {
    throw new EngineError(['Only cooling or incubating ideas go through the firewall.']);
  }
  if (decision === 'promote') {
    const missing = (['reality', 'evidence', 'cost', 'exit'] as const).filter((g) => !gates[g].trim());
    if (missing.length) throw new EngineError([`Answer every gate before promoting (missing: ${missing.join(', ')}).`]);
  }
  const review: FirewallReview = { ...gates, decision, at: now.toISOString() };
  const reviewed = replaceProject(db, { ...p, firewall: review });
  if (decision === 'defer') {
    if (p.state === 'incubator') return reviewed;
    return transition(reviewed, id, 'incubator', { reason: 'capacity', note: 'Deferred by firewall' }, now);
  }
  if (decision === 'decline') {
    return transition(reviewed, id, 'archived', { reason: 'release', note: 'Declined by firewall' }, now);
  }
  return transition(
    reviewed,
    id,
    'active',
    { reason: 'evidence', note: 'Promoted by firewall', layer: opts.layer, coexist: opts.coexist },
    now,
  );
}

// ---------- Attention router + sessions ----------

export function daysUntil(date: string, now: Date): number {
  const d = new Date(`${date}T23:59:59`);
  return Math.floor((d.getTime() - now.getTime()) / DAY);
}

/** Active anchors due within two days, or overdue. */
export function urgentAnchors(db: Db, now: Date): Project[] {
  return db.projects
    .filter((p) => p.layer === 'anchor' && p.state === 'active' && p.deadline && daysUntil(p.deadline, now) <= 2)
    .sort((a, b) => a.deadline!.localeCompare(b.deadline!));
}

function lastWorked(db: Db, id: string): string {
  let last = '';
  for (const s of db.sessions) if (s.projectId === id && s.startedAt > last) last = s.startedAt;
  return last;
}

/** Active work whose next action fits the current capacity; least recently touched first. */
export function route(db: Db, capacity: Capacity, now: Date): { urgent: Project[]; options: Project[] } {
  const urgent = urgentAnchors(db, now);
  const urgentIds = new Set(urgent.map((p) => p.id));
  const options = db.projects
    .filter(
      (p) =>
        p.state === 'active' &&
        !urgentIds.has(p.id) &&
        isNextComplete(p.card.next) &&
        CAPACITY_RANK[p.card.next.energy] <= CAPACITY_RANK[capacity],
    )
    .sort((a, b) => lastWorked(db, a.id).localeCompare(lastWorked(db, b.id)));
  return { urgent, options };
}

/** Randomizer for choice paralysis: urgent obligations are already excluded by `route`. */
export function randomPick<T>(items: T[], rand = Math.random): T | undefined {
  return items.length ? items[Math.floor(rand() * items.length)] : undefined;
}

export function openSession(db: Db): Session | undefined {
  return db.sessions.find((s) => !s.endedAt);
}

export function startSession(
  db: Db,
  projectId: string,
  capacity: Capacity,
  plannedMin: number,
  now: Date,
  bodyDouble?: boolean,
): Db {
  if (openSession(db)) throw new EngineError(['Close the current session first.']);
  if (openPitStop(db)) throw new EngineError(['Finish the pit stop first.']);
  const p = getProject(db, projectId);
  if (p.state !== 'active') throw new EngineError(['Sessions run on active work only.']);
  const session: Session = { id: newId(), projectId, capacity, plannedMin, startedAt: now.toISOString() };
  if (bodyDouble) session.bodyDouble = true;
  return { ...db, sessions: [...db.sessions, session] };
}

export function markResume(db: Db, sessionId: string, quick: boolean): Db {
  return { ...db, sessions: db.sessions.map((s) => (s.id === sessionId ? { ...s, resumedQuickly: quick } : s)) };
}

export interface CloseInput {
  output: string;
  outputKind: OutputKind | 'none';
  blocker: string;
  next: NextAction;
  file?: string;
  lastThought: string;
  decision: 'continue' | 'rotate' | 'pause';
  pauseReason?: string;
}

/** Session close (2 min): log output, blocker, next action and file; then continue, rotate or pause. */
export function closeSession(db: Db, sessionId: string, input: CloseInput, now: Date): Db {
  const s = db.sessions.find((x) => x.id === sessionId);
  if (!s || s.endedAt) throw new EngineError(['No open session to close.']);
  if (!isNextComplete(input.next)) throw new EngineError(['Leave a beacon: the next action needs all four parts.']);
  const p = getProject(db, s.projectId);
  const files = input.file?.trim() && !p.card.files.includes(input.file.trim())
    ? [...p.card.files, input.file.trim()]
    : p.card.files;
  const card: ReentryCard = {
    ...p.card,
    currentState: input.output.trim() || p.card.currentState,
    next: input.next,
    blocker: input.blocker.trim(),
    lastThought: input.lastThought.trim(),
    files,
  };
  let out = updateProject(db, p.id, { card }, now);
  out = {
    ...out,
    sessions: out.sessions.map((x) =>
      x.id === sessionId
        ? { ...x, endedAt: now.toISOString(), output: input.output.trim(), outputKind: input.outputKind, decision: input.decision }
        : x,
    ),
  };
  if (input.decision === 'pause') {
    out = transition(out, p.id, 'paused', { reason: 'capacity', note: input.pauseReason ?? '' }, now);
  }
  return out;
}

// ---------- Rituals ----------

export const isoDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function todaysOpen(db: Db, now: Date) {
  return db.daily.find((d) => d.date === isoDate(now));
}

export function setDailyOpen(db: Db, intent: string, projectId: string | undefined, now: Date): Db {
  const date = isoDate(now);
  return { ...db, daily: [...db.daily.filter((d) => d.date !== date), { date, intent: intent.trim(), projectId }] };
}

export function saveWeeklyReview(db: Db, overheadMin: number, misses: Miss[], note: string, now: Date): Db {
  const review = { id: newId(), at: now.toISOString(), overheadMin, misses: misses.filter((m) => m.what.trim()), note };
  return { ...db, reviews: [...db.reviews, review] };
}

export function openPitStop(db: Db) {
  return db.pitstops.find((p) => !p.endedAt);
}

/** Pit stop: charge equipment, gather references, prepare the workspace, small maintenance. */
export function startPitStop(db: Db, what: string, plannedMin: number, now: Date): Db {
  if (openSession(db) || openPitStop(db)) throw new EngineError(['Something is already running.']);
  if (plannedMin <= 0 || plannedMin > 30) throw new EngineError(['Pit stops are capped at 30 minutes so preparation does not become avoidance.']);
  const stop = { id: newId(), what: what.trim() || 'Preparation', plannedMin, startedAt: now.toISOString() };
  return { ...db, pitstops: [...db.pitstops, stop] };
}

export function endPitStop(db: Db, now: Date): Db {
  const open = openPitStop(db);
  if (!open) throw new EngineError(['No pit stop running.']);
  return { ...db, pitstops: db.pitstops.map((p) => (p.id === open.id ? { ...p, endedAt: now.toISOString() } : p)) };
}

// ---------- Experiments ----------

export const mechanismOn = (db: Db, k: MechanismKey) => db.settings.mechanisms[k].status !== 'off';

export function setMechanism(db: Db, k: MechanismKey, status: MechanismStatus, note: string, now: Date): Db {
  const prev = db.settings.mechanisms[k];
  const since = status === 'trial' ? (prev.status === 'trial' ? prev.since : now.toISOString()) : undefined;
  return {
    ...db,
    settings: { ...db.settings, mechanisms: { ...db.settings.mechanisms, [k]: { status, since, note } } },
  };
}

export function setBaseline(db: Db, b: Omit<Baseline, 'at'>, now: Date): Db {
  return { ...db, baseline: { ...b, at: now.toISOString() } };
}

/** Two-week pilot: week 1 capture + re-entry cards, week 2 adds firewall + weekly reset. */
export function pilotWeek(db: Db, now: Date): 0 | 1 | 2 | 3 {
  if (!db.pilotStartedAt) return 0;
  const days = (now.getTime() - new Date(db.pilotStartedAt).getTime()) / DAY;
  return days < 7 ? 1 : days < 14 ? 2 : 3;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** External cue: anchor deadlines as an all-day calendar feed. */
export function deadlinesIcs(db: Db, now: Date): string {
  const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;
  const esc = (s: string) => s.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
  const events = db.projects
    .filter((p) => p.deadline && (p.state === 'active' || p.state === 'paused'))
    .map((p) => {
      const d = p.deadline!.replace(/-/g, '');
      const end = new Date(`${p.deadline}T00:00:00`);
      end.setDate(end.getDate() + 1);
      return [
        'BEGIN:VEVENT',
        `UID:${p.id}@edp-engine`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${d}`,
        `DTEND;VALUE=DATE:${isoDate(end).replace(/-/g, '')}`,
        `SUMMARY:${esc(p.title)}`,
        `DESCRIPTION:${esc(`NEXT: ${formatNext(p.card.next)}`)}`,
        'END:VEVENT',
      ].join('\r\n');
    });
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//EDP Engine//EN', ...events, 'END:VCALENDAR'].join('\r\n') + '\r\n';
}

// ---------- Measurement ----------

export function weekStart(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7)); // Monday
  return s;
}

export interface WeekMetrics {
  start: Date;
  reentry: { success: number; total: number };
  outputs: number;
  misses: number;
  overheadMin: number | null;
  minutesWorked: number;
  pitStopMin: number;
  causes: Partial<Record<MissCause, number>>;
  /** Re-entry success split by body doubling, to treat it as an experiment. */
  bodyDouble: { with: { success: number; total: number }; without: { success: number; total: number } };
}

const minutes = (a: string, b?: string) => (b ? (new Date(b).getTime() - new Date(a).getTime()) / 60_000 : 0);
const rate = (xs: Session[]) => ({ success: xs.filter((s) => s.resumedQuickly).length, total: xs.length });

export function weeklyMetrics(db: Db, start: Date): WeekMetrics {
  const end = new Date(start.getTime() + 7 * DAY);
  const inWeek = (iso: string) => {
    const t = new Date(iso).getTime();
    return t >= start.getTime() && t < end.getTime();
  };
  const sessions = db.sessions.filter((s) => inWeek(s.startedAt));
  const rated = sessions.filter((s) => s.resumedQuickly !== undefined);
  const completions = db.projects.flatMap((p) => p.history).filter((t) => t.to === 'completed' && inWeek(t.at));
  const reviews = db.reviews.filter((r) => inWeek(r.at));
  const causes: Partial<Record<MissCause, number>> = {};
  for (const m of reviews.flatMap((r) => r.misses)) causes[m.cause] = (causes[m.cause] ?? 0) + 1;
  return {
    start,
    reentry: rate(rated),
    causes,
    bodyDouble: { with: rate(rated.filter((s) => s.bodyDouble)), without: rate(rated.filter((s) => !s.bodyDouble)) },
    pitStopMin: db.pitstops.filter((p) => inWeek(p.startedAt)).reduce((n, p) => n + minutes(p.startedAt, p.endedAt), 0),
    outputs: sessions.filter((s) => s.outputKind && s.outputKind !== 'none').length + completions.length,
    misses: reviews.reduce((n, r) => n + r.misses.length, 0),
    overheadMin: reviews.length ? reviews.reduce((n, r) => n + r.overheadMin, 0) : null,
    minutesWorked: sessions.reduce((n, s) => n + minutes(s.startedAt, s.endedAt), 0),
  };
}

/** Failure signals from the measurement plan: the engine is becoming another project. */
export function failureSignals(db: Db, now: Date): string[] {
  const out: string[] = [];
  const staleInbox = db.projects.filter(
    (p) => p.state === 'inbox' && now.getTime() - new Date(p.createdAt).getTime() > 7 * DAY,
  );
  if (staleInbox.length >= 5) out.push(`${staleInbox.length} inbox items are over a week old without a decision.`);
  const vague = db.projects.filter((p) => p.state === 'active' && !isNextComplete(p.card.next));
  if (vague.length) out.push(`${vague.length} active item(s) have no concrete next action.`);
  // Count from the last reset, or from first use if there hasn't been one yet.
  const since = db.reviews.at(-1)?.at ?? db.projects.map((p) => p.createdAt).sort()[0];
  if (since && (now.getTime() - new Date(since).getTime()) / DAY > 10) {
    out.push('The weekly reset has been skipped for over 10 days.');
  }
  const recent = db.reviews.slice(-2);
  if (recent.length === 2 && recent.every((r) => r.overheadMin > 60)) {
    out.push('System overhead has exceeded an hour for two weeks. Simplify it.');
  }
  const week = weeklyMetrics(db, weekStart(now));
  if (week.pitStopMin >= 30 && week.pitStopMin > week.minutesWorked) {
    out.push('Productivity theatre: more time went to preparation than to real work this week.');
  }
  const trials = Object.values(db.settings.mechanisms).filter((m) => m.status === 'trial').length;
  if (trials > 1) out.push(`${trials} mechanisms are on trial at once. Change one major variable at a time.`);
  return out;
}

/** Paused work untouched for two weeks is a candidate for deliberate release. */
export function stalePaused(db: Db, now: Date): Project[] {
  return db.projects.filter((p) => p.state === 'paused' && now.getTime() - new Date(p.updatedAt).getTime() > 14 * DAY);
}
