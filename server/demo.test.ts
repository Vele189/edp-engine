import { describe, expect, it } from 'vitest';
import { activeStudio, failureSignals, isNextComplete } from '../src/engine/engine';
import { clusters } from '../src/engine/graph';
import { buildDemo } from './demo';

// A Tuesday morning, like the day this was written; the story is relative to it.
const today = new Date('2026-10-27T09:30:00');

describe('demo story', () => {
  const db = buildDemo(today);

  it('plays through the engine without breaking a rule', () => {
    expect(db.projects).toHaveLength(12);
    expect(activeStudio(db).length).toBeLessThanOrEqual(db.settings.activeLimit);
    for (const p of db.projects.filter((x) => x.state === 'active' || x.state === 'paused')) {
      expect(isNextComplete(p.card.next), p.title).toBe(true);
    }
    expect(db.sessions.every((s) => s.endedAt)).toBe(true);
    expect(failureSignals(db, today)).toEqual([]);
  });

  it('covers every stage of the flow', () => {
    const states = new Set(db.projects.map((p) => p.state));
    for (const s of ['inbox', 'experiment', 'cooling', 'incubator', 'active', 'paused', 'completed', 'archived']) {
      expect(states.has(s as never), s).toBe(true);
    }
    const decisions = new Set(db.projects.map((p) => p.firewall?.decision).filter(Boolean));
    expect(decisions).toEqual(new Set(['promote', 'defer', 'decline']));
    expect(db.baseline).toBeDefined();
    expect(db.reviews).toHaveLength(1);
    expect(db.pitstops).toHaveLength(2);
    expect(db.settings.mechanisms.bodyDoubling.status).toBe('trial');
  });

  it('shows re-entry improving from week 1 to week 2', () => {
    const split = new Date(db.pilotStartedAt!).getTime() + 7 * 86_400_000;
    const week1 = db.sessions.filter((s) => new Date(s.startedAt).getTime() < split);
    const week2 = db.sessions.filter((s) => !week1.includes(s));
    const rate = (xs: typeof week1) => xs.filter((s) => s.resumedQuickly).length / xs.filter((s) => s.resumedQuickly !== undefined).length;
    expect(rate(week2)).toBeGreaterThan(rate(week1));
  });

  it('builds a brain with groups, a person, a decision and correctly directed links', () => {
    expect(new Set(db.notes.map((n) => n.kind))).toEqual(new Set(['decision', 'person', 'insight', 'context', 'reference']));
    const { clusters: cs } = clusters(db, true);
    expect(cs[0].hub.title).toBe('Synth EP');
    expect(cs.length).toBeGreaterThanOrEqual(2);
    const title = (id: string) => [...db.projects, ...db.notes].find((n) => n.id === id)!.title;
    const inspired = db.links.find((l) => l.relation === 'inspired-by')!;
    expect(`${title(inspired.a)} inspired by ${title(inspired.b)}`).toBe('Pixel-art palette tool inspired by Pixel tools I admire');
  });

  it('puts the tax deadline first today', () => {
    const tax = db.projects.find((p) => p.title === 'Quarterly tax return')!;
    expect(db.daily.at(-1)).toMatchObject({ intent: 'File the tax return', projectId: tax.id });
  });
});
