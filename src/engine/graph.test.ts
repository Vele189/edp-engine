import { describe, expect, it } from 'vitest';
import { EngineError, capture, emptyDb, migrate } from './engine';
import { clusters, createNote, deleteNote, edgesOf, describeEdge, link, neighborhood, search, unlink } from './graph';
import type { Db } from './types';

const now = new Date('2026-10-27T10:00:00');

function seed(): { db: Db; ep: string; studio: string; tax: string; ableton: string } {
  let db = capture(emptyDb(), 'Synth EP', 'creative outlet, four tracks', now);
  const ep = db.projects[0].id;
  db = capture(db, 'Home studio upgrade', 'better monitors', now);
  const studio = db.projects[0].id;
  db = capture(db, 'Tax return', 'due Friday', now);
  const tax = db.projects[0].id;
  db = createNote(db, { title: 'Ableton workflow', body: 'Resampling chains make bass design faster', kind: 'insight', source: 'chat' }, now, 'note-ableton');
  return { db, ep, studio, tax, ableton: 'note-ableton' };
}

describe('graph', () => {
  it('migrates older data with an empty brain', () => {
    const db = migrate({ version: 2, projects: [], sessions: [], pitstops: [], reviews: [], daily: [], settings: {} });
    expect(db.version).toBe(3);
    expect(db.notes).toEqual([]);
    expect(db.links).toEqual([]);
  });

  it('keeps notes out of the inbox and the state machine', () => {
    const { db } = seed();
    expect(db.projects.filter((p) => p.state === 'inbox')).toHaveLength(3);
    expect(db.notes[0]).toMatchObject({ kind: 'insight', source: 'chat' });
  });

  it('requires a real reason and refuses self-links', () => {
    const { db, ep } = seed();
    expect(() => link(db, ep, ep, 'supports', 'it supports itself somehow', 'claude', now)).toThrow(EngineError);
    expect(() => link(db, ep, 'note-ableton', 'context-for', 'music', 'claude', now)).toThrow(/why/);
    expect(() => link(db, ep, 'missing', 'supports', 'a perfectly good reason', 'claude', now)).toThrow(/No node/);
  });

  it('re-describes an existing pair instead of duplicating it', () => {
    let { db, ep, ableton } = seed();
    db = link(db, ableton, ep, 'context-for', 'Bass design technique for the EP tracks', 'claude', now);
    db = link(db, ep, ableton, 'inspired-by', 'The EP sound grew out of this resampling habit', 'user', now);
    expect(db.links).toHaveLength(1);
    expect(db.links[0]).toMatchObject({ relation: 'inspired-by', by: 'user' });
  });

  it('phrases edges from either side', () => {
    let { db, ep, studio } = seed();
    db = link(db, ep, studio, 'depends-on', 'Mixing the EP needs the new monitors', 'claude', now);
    expect(describeEdge(edgesOf(db, ep)[0])).toBe('depends on Home studio upgrade');
    expect(describeEdge(edgesOf(db, studio)[0])).toBe('Synth EP depends on this');
  });

  it('groups connected nodes, names groups by their hub, and lists orphans', () => {
    let { db, ep, studio, tax, ableton } = seed();
    db = link(db, ep, studio, 'depends-on', 'Mixing the EP needs the new monitors', 'claude', now);
    db = link(db, ableton, ep, 'context-for', 'Bass design technique for the EP tracks', 'claude', now);
    const { clusters: cs, orphans } = clusters(db);
    expect(cs).toHaveLength(1);
    expect(cs[0].hub.title).toBe('Synth EP');
    expect(cs[0].members.map((m) => m.id).sort()).toEqual([ep, studio, ableton].sort());
    expect(orphans.map((o) => o.id)).toEqual([tax]);
    expect(neighborhood(db, studio, 2).map((n) => [n.node.title, n.hops])).toEqual([
      ['Synth EP', 1],
      ['Ableton workflow', 2],
    ]);
  });

  it('unlinking splits groups, and deleting a note removes its links', () => {
    let { db, ep, studio, ableton } = seed();
    db = link(db, ep, studio, 'depends-on', 'Mixing the EP needs the new monitors', 'claude', now);
    db = link(db, ableton, ep, 'context-for', 'Bass design technique for the EP tracks', 'claude', now);
    db = deleteNote(db, ableton);
    expect(db.links).toHaveLength(1);
    db = unlink(db, studio, ep);
    expect(clusters(db).clusters).toHaveLength(0);
  });

  it('shortlists candidates by word overlap, title first', () => {
    const { db } = seed();
    const hits = search(db, 'bass design for the synth tracks');
    expect(hits[0].node.title).toBe('Synth EP');
    expect(hits.map((h) => h.node.title)).toContain('Ableton workflow');
    expect(hits.map((h) => h.node.title)).not.toContain('Tax return');
  });
});

describe('folder projects', () => {
  it('make the folder-linked project the parent of its group', async () => {
    const { updateProject } = await import('./engine');
    let { db, ep, studio } = seed();
    db = link(db, ep, studio, 'depends-on', 'Mixing the EP needs the new monitors', 'claude', now);
    db = link(db, 'note-ableton', studio, 'context-for', 'Studio setup notes for the upgrade', 'claude', now);
    expect(clusters(db).clusters[0].hub.title).toBe('Home studio upgrade'); // most links
    db = updateProject(db, ep, { folder: 'synth-ep' }, now);
    const c = clusters(db).clusters[0];
    expect(c.hub.title).toBe('Synth EP');
    expect(c.hub.folder).toBe('synth-ep');
  });
});
