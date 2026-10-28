/** Layer A — Anchors, Layer B — Active Studio, Layer C — Wild Garden. */
export type Layer = 'anchor' | 'studio' | 'garden';

export type State =
  | 'inbox'
  | 'experiment'
  | 'cooling'
  | 'incubator'
  | 'active'
  | 'paused'
  | 'completed'
  | 'archived';

export type Capacity = 'low' | 'medium' | 'high';

/** Transition rule: no state change without a reason. */
export type ReasonKind = 'evidence' | 'capacity' | 'deadline' | 'outcome' | 'release' | 'test';

export type OutputKind = 'shipped' | 'tested' | 'solved' | 'published' | 'obligation';

/** Pause beacon: NEXT: [verb] + [specific object] + [location] + [done condition]. */
export interface NextAction {
  verb: string;
  object: string;
  location: string;
  done: string;
  /** Capacity needed to do it; used by the attention router. */
  energy: Capacity;
}

export interface ReentryCard {
  outcome: string;
  currentState: string;
  next: NextAction;
  files: string[];
  lastThought: string;
  blocker: string;
  definitionOfDone: string;
}

export interface Experiment {
  question: string;
  timeCapMin: number;
  startedAt: string;
  result?: string;
}

export interface FirewallReview {
  reality: string;
  evidence: string;
  cost: string;
  exit: string;
  decision: 'promote' | 'defer' | 'decline';
  at: string;
}

export interface Transition {
  from: State;
  to: State;
  reason: ReasonKind;
  note: string;
  at: string;
}

export interface Project {
  id: string;
  title: string;
  why: string;
  layer: Layer;
  state: State;
  createdAt: string;
  updatedAt: string;
  /** ISO date (YYYY-MM-DD); mostly for anchors. */
  deadline?: string;
  card: ReentryCard;
  experiment?: Experiment;
  firewall?: FirewallReview;
  /** Written justification when an active studio project exceeds the trio. */
  coexist?: string;
  completion?: string;
  /** Project folder, relative to the workspace root. Makes this project a parent node in the brain. */
  folder?: string;
  history: Transition[];
}

export interface Session {
  id: string;
  projectId: string;
  capacity: Capacity;
  plannedMin: number;
  startedAt: string;
  /** Metric 1: did work resume within ~60 seconds using the card? */
  resumedQuickly?: boolean;
  endedAt?: string;
  output?: string;
  outputKind?: OutputKind | 'none';
  decision?: 'continue' | 'rotate' | 'pause';
  /** Worked alongside someone or in a co-working session. */
  bodyDouble?: boolean;
}

/** Low-dopamine pit stop: capped preparation that must not become avoidance. */
export interface PitStop {
  id: string;
  what: string;
  plannedMin: number;
  startedAt: string;
  endedAt?: string;
}

/** A missed task is information about scope, cues, capacity or friction. */
export type MissCause = 'scope' | 'cues' | 'capacity' | 'friction' | 'other';

export interface Miss {
  what: string;
  cause: MissCause;
  note: string;
}

export interface WeeklyReview {
  id: string;
  at: string;
  overheadMin: number;
  misses: Miss[];
  note: string;
}

export interface DailyOpen {
  date: string;
  intent: string;
  projectId?: string;
}

/** Optional mechanisms. Iteration rule: keep only those that measurably help. */
export type MechanismKey =
  | 'playground'
  | 'randomizer'
  | 'pitStop'
  | 'bodyDoubling'
  | 'notifications'
  | 'hyperfocusGuard'
  | 'coolDown'
  | 'failureSignals';

export type MechanismStatus = 'on' | 'trial' | 'off';

export interface Mechanism {
  status: MechanismStatus;
  /** When the current trial started. */
  since?: string;
  note: string;
}

export interface Settings {
  /** Default constraint, not a moral law. */
  activeLimit: number;
  coolDownHours: number;
  mechanisms: Record<MechanismKey, Mechanism>;
  /** The folder that holds the person's projects (absolute path). Read-only for the engine. */
  workspaceRoot?: string;
}

/** Week 0: approximate, before the engine changes anything. */
export interface Baseline {
  restartDelayMin: number;
  missesPerWeek: number;
  outputsPerWeek: number;
  planningDisplaces: 'rarely' | 'sometimes' | 'often';
  at: string;
}

/** Non-actionable context: never enters the inbox or the state machine. */
export type NoteKind = 'context' | 'insight' | 'decision' | 'reference' | 'person' | 'theme';

export interface Note {
  id: string;
  title: string;
  /** Markdown-ish detail: the highlight or context worth remembering. */
  body: string;
  kind: NoteKind;
  /** Where it came from: a chat with Claude, or typed in the app. */
  source: 'chat' | 'app';
  createdAt: string;
  updatedAt: string;
}

/** How two nodes relate. Links are undirected for grouping; `relation` reads from a to b. */
export type Relation = 'part-of' | 'depends-on' | 'supports' | 'conflicts-with' | 'inspired-by' | 'same-theme' | 'context-for';

export interface Link {
  id: string;
  a: string;
  b: string;
  relation: Relation;
  /** Why these two nodes communicate. Required: no keyword-only links. */
  why: string;
  by: 'claude' | 'user';
  createdAt: string;
}

export interface Db {
  version: 3;
  projects: Project[];
  sessions: Session[];
  pitstops: PitStop[];
  reviews: WeeklyReview[];
  daily: DailyOpen[];
  settings: Settings;
  baseline?: Baseline;
  pilotStartedAt?: string;
  notes: Note[];
  links: Link[];
}
