import { describe, expect, it } from 'vitest';
import {
  EngineError,
  capture,
  closeSession,
  emptyDb,
  failureSignals,
  route,
  runFirewall,
  startSession,
  transition,
  updateProject,
  weekStart,
  weeklyMetrics,
} from './engine';
import type { Db, NextAction } from './types';

const now = new Date('2026-10-27T10:00:00');
const next: NextAction = { verb: 'Open', object: 'poster.fig', location: 'Figma', done: 'headline moved', energy: 'low' };
const gates = { reality: 'Less gaming', evidence: 'Prototype', cost: '3h/week', exit: 'No users in 4 weeks' };

function withIdea(db: Db, title = 'Idea'): [Db, string] {
  const out = capture(db, title, 'because', now);
  return [out, out.projects[0].id];
}

function readyCard(db: Db, id: string): Db {
  return updateProject(db, id, { card: { ...db.projects.find((p) => p.id === id)!.card, outcome: 'Ship v1', currentState: 'Draft', next } }, now);
}

function promoted(db: Db, title: string): [Db, string] {
  let [out, id] = withIdea(db, title);
  out = readyCard(out, id);
  out = transition(out, id, 'cooling', { reason: 'evidence' }, now);
  out = runFirewall(out, id, gates, 'promote', { layer: 'studio' }, now);
  return [out, id];
}

describe('state machine', () => {
  it('captures into the inbox in the wild garden', () => {
    const [db] = withIdea(emptyDb());
    expect(db.projects[0]).toMatchObject({ state: 'inbox', layer: 'garden' });
  });

  it('rejects edges not in the diagram', () => {
    const [db, id] = withIdea(emptyDb());
    expect(() => transition(db, id, 'completed', { reason: 'outcome', completion: 'x' }, now)).toThrow(EngineError);
  });

  it('requires a question and time cap for experiments', () => {
    const [db, id] = withIdea(emptyDb());
    expect(() => transition(db, id, 'experiment', { reason: 'test' }, now)).toThrow(/learning question/);
    const out = transition(db, id, 'experiment', { reason: 'test', experiment: { question: 'Will anyone use it?', timeCapMin: 60 } }, now);
    expect(out.projects[0].state).toBe('experiment');
    expect(out.projects[0].history).toHaveLength(1);
  });

  it('blocks promotion that skips the firewall', () => {
    let [db, id] = withIdea(emptyDb());
    db = readyCard(db, id);
    db = transition(db, id, 'cooling', { reason: 'evidence' }, now);
    expect(() => transition(db, id, 'active', { reason: 'evidence', layer: 'studio' }, now)).toThrow(/Firewall/);
  });

  it('requires a beacon and reason to pause', () => {
    let [db, id] = promoted(emptyDb(), 'A');
    expect(() => transition(db, id, 'paused', { reason: 'capacity' }, now)).toThrow(/clear reason/);
    db = updateProject(db, id, { card: { ...db.projects[0].card, next: { ...next, verb: '' } } }, now);
    expect(() => transition(db, id, 'paused', { reason: 'capacity', note: 'tired' }, now)).toThrow(/beacon/);
  });
});

describe('commitment firewall', () => {
  it('needs every gate answered to promote', () => {
    let [db, id] = withIdea(emptyDb());
    db = readyCard(db, id);
    db = transition(db, id, 'cooling', { reason: 'evidence' }, now);
    expect(() => runFirewall(db, id, { ...gates, exit: '' }, 'promote', { layer: 'studio' }, now)).toThrow(/exit/);
  });

  it('defers to the incubator and declines to the archive', () => {
    let [db, a] = withIdea(emptyDb(), 'A');
    let b: string;
    [db, b] = withIdea(db, 'B');
    db = transition(db, a, 'cooling', { reason: 'evidence' }, now);
    db = transition(db, b, 'cooling', { reason: 'evidence' }, now);
    db = runFirewall(db, a, gates, 'defer', {}, now);
    db = runFirewall(db, b, gates, 'decline', {}, now);
    expect(db.projects.find((p) => p.id === a)!.state).toBe('incubator');
    expect(db.projects.find((p) => p.id === b)!.state).toBe('archived');
  });

  it('enforces the active trio unless coexistence is explicit', () => {
    let db = emptyDb();
    for (const t of ['A', 'B', 'C']) [db] = promoted(db, t);
    let [d, id] = withIdea(db, 'D');
    d = readyCard(d, id);
    d = transition(d, id, 'cooling', { reason: 'evidence' }, now);
    expect(() => runFirewall(d, id, gates, 'promote', { layer: 'studio' }, now)).toThrow(/already has 3/);
    const ok = runFirewall(d, id, gates, 'promote', { layer: 'studio', coexist: 'Client deadline Friday' }, now);
    expect(ok.projects.find((p) => p.id === id)!.state).toBe('active');
    // Anchors never count toward the trio.
    const anchor = runFirewall(d, id, gates, 'promote', { layer: 'anchor' }, now);
    expect(anchor.projects.find((p) => p.id === id)!.layer).toBe('anchor');
  });
});

describe('router and sessions', () => {
  it('puts urgent anchors first and filters by capacity', () => {
    let [db, a] = promoted(emptyDb(), 'Taxes');
    db = updateProject(db, a, { layer: 'anchor', deadline: '2026-10-28' }, now);
    let b: string;
    [db, b] = promoted(db, 'Album');
    db = updateProject(db, b, { card: { ...db.projects.find((p) => p.id === b)!.card, next: { ...next, energy: 'high' } } }, now);
    const low = route(db, 'low', now);
    expect(low.urgent.map((p) => p.title)).toEqual(['Taxes']);
    expect(low.options).toHaveLength(0);
    expect(route(db, 'high', now).options.map((p) => p.title)).toEqual(['Album']);
  });

  it('closing a session updates the card and can pause', () => {
    let [db, id] = promoted(emptyDb(), 'A');
    db = startSession(db, id, 'medium', 30, now);
    expect(() => startSession(db, id, 'medium', 30, now)).toThrow(/current session/);
    const sid = db.sessions[0].id;
    db = closeSession(
      db,
      sid,
      { output: 'Drafted intro', outputKind: 'published', blocker: '', next, file: 'notes.md', lastThought: 'tone', decision: 'pause', pauseReason: 'rotating' },
      new Date(now.getTime() + 30 * 60_000),
    );
    const p = db.projects[0];
    expect(p.state).toBe('paused');
    expect(p.card.files).toEqual(['notes.md']);
    expect(p.card.currentState).toBe('Drafted intro');
    const m = weeklyMetrics(db, weekStart(now));
    expect(m.outputs).toBe(1);
    expect(Math.round(m.minutesWorked)).toBe(30);
  });
});

describe('failure signals', () => {
  it('flags active work without a next action', () => {
    let [db, id] = promoted(emptyDb(), 'A');
    db = updateProject(db, id, { card: { ...db.projects[0].card, next: { ...next, done: '' } } }, now);
    expect(failureSignals(db, now).join(' ')).toMatch(/no concrete next action/);
  });
});

describe('remaining mechanisms', () => {
  it('migrates v1 data with free-text miss causes', async () => {
    const { migrate } = await import('./engine');
    const v1 = { version: 1, projects: [], sessions: [], reviews: [{ id: 'r', at: now.toISOString(), overheadMin: 5, note: '', misses: [{ what: 'tax', cause: 'forgot' }] }], daily: [], settings: { activeLimit: 2, coolDownHours: 24 } };
    const db = migrate(v1);
    expect(db.version).toBe(3);
    expect(db.pitstops).toEqual([]);
    expect(db.settings.activeLimit).toBe(2);
    expect(db.settings.mechanisms.randomizer.status).toBe('on');
    expect(db.reviews[0].misses[0]).toEqual({ what: 'tax', cause: 'other', note: 'forgot' });
  });

  it('caps pit stops and flags productivity theatre', async () => {
    const { startPitStop, endPitStop } = await import('./engine');
    expect(() => startPitStop(emptyDb(), 'cables', 45, now)).toThrow(/30 minutes/);
    let db = startPitStop(emptyDb(), 'cables', 30, now);
    expect(() => startPitStop(db, 'x', 5, now)).toThrow(/already running/);
    db = endPitStop(db, new Date(now.getTime() + 40 * 60_000));
    expect(weeklyMetrics(db, weekStart(now)).pitStopMin).toBe(40);
    expect(failureSignals(db, now).join(' ')).toMatch(/Productivity theatre/);
  });

  it('tracks trials and warns about more than one at a time', async () => {
    const { setMechanism, mechanismOn } = await import('./engine');
    let db = setMechanism(emptyDb(), 'bodyDoubling', 'trial', '', now);
    expect(mechanismOn(db, 'bodyDoubling')).toBe(true);
    expect(db.settings.mechanisms.bodyDoubling.since).toBe(now.toISOString());
    db = setMechanism(db, 'notifications', 'trial', '', now);
    expect(failureSignals(db, now).join(' ')).toMatch(/one major variable/);
    db = setMechanism(db, 'randomizer', 'off', 'never used', now);
    expect(mechanismOn(db, 'randomizer')).toBe(false);
  });

  it('splits re-entry by body doubling and counts miss causes', async () => {
    const { markResume, saveWeeklyReview } = await import('./engine');
    let [db, id] = promoted(emptyDb(), 'A');
    db = startSession(db, id, 'low', 15, now, true);
    db = markResume(db, db.sessions[0].id, true);
    db = saveWeeklyReview(db, 10, [{ what: 'call', cause: 'cues', note: '' }, { what: '', cause: 'scope', note: '' }], '', now);
    const m = weeklyMetrics(db, weekStart(now));
    expect(m.bodyDouble.with).toEqual({ success: 1, total: 1 });
    expect(m.causes).toEqual({ cues: 1 });
  });

  it('exports anchor deadlines as an all-day calendar event', async () => {
    const { deadlinesIcs } = await import('./engine');
    let [db, id] = promoted(emptyDb(), 'Taxes, Q3');
    db = updateProject(db, id, { layer: 'anchor', deadline: '2026-10-31' }, now);
    const ics = deadlinesIcs(db, now);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261031');
    expect(ics).toContain('DTEND;VALUE=DATE:20261101');
    expect(ics).toContain('SUMMARY:Taxes\\, Q3');
    expect(ics.split('\r\n')[0]).toBe('BEGIN:VCALENDAR');
  });
});

describe('weekly reset signal', () => {
  it('does not nag a brand-new user, but does after 10 days of use', () => {
    const [db] = withIdea(emptyDb());
    expect(failureSignals(db, now).join(' ')).not.toMatch(/weekly reset/);
    expect(failureSignals(db, new Date(now.getTime() + 11 * 86_400_000)).join(' ')).toMatch(/weekly reset/);
  });
});
