import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SceneElement } from '../src/board/merge';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edp-boards-'));
let B: typeof import('./boards');

beforeAll(async () => {
  vi.stubEnv('EDP_DB', path.join(dir, 'db.json'));
  B = await import('./boards');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const el = (id: string, version: number, extra: Record<string, unknown> = {}): SceneElement => ({ id, version, versionNonce: 1, ...extra });

describe('boards', () => {
  it('keeps board files next to the database, one per node', () => {
    expect(B.BOARDS_DIR).toBe(path.join(dir, 'boards'));
    expect(() => B.boardPath('../../etc/passwd')).toThrow(/Invalid/);
  });

  it('merges by element version so concurrent edits and deletions survive', () => {
    const merged = B.mergeElements(
      [el('a', 3, { text: 'server a' }), el('b', 1), el('c', 5)],
      [el('a', 2, { text: 'stale a' }), el('b', 2, { isDeleted: true }), el('d', 1)],
    );
    expect(merged.find((e) => e.id === 'a')!.text).toBe('server a');
    expect(merged.find((e) => e.id === 'b')!.isDeleted).toBe(true);
    expect(merged.map((e) => e.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('queues Claude items, then the browser draws and consumes them', () => {
    const id = 'node-1234';
    const queued = B.addPending(id, [{ type: 'sticky', text: 'Plan step one', color: 'yellow' }]);
    expect(queued.pending).toHaveLength(1);
    const saved = B.saveBoard(id, { elements: [el('t1', 1, { type: 'text', text: 'Plan step one', y: 10 })], consumed: [queued.pending[0].id] });
    expect(saved.pending).toHaveLength(0);
    expect(saved.rev).toBe(queued.rev + 1);
    expect(B.boardText(saved)).toEqual(['Plan step one']);
    expect(B.listBoards()).toMatchObject([{ nodeId: id, elements: 1, pending: 0 }]);
  });
});
