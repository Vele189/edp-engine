import fs from 'node:fs';
import path from 'node:path';
import { mergeElements, type SceneElement } from '../src/board/merge';
import { DB_PATH, withLock } from './fileStore';

export { mergeElements };

/**
 * Boards: an optional FigJam-style canvas (Excalidraw scene) per node, one file each,
 * kept out of db.json so a large drawing never slows down ordinary edits.
 *
 * Claude can't run Excalidraw (it needs a browser), so it appends `pending` items
 * (headings, handwritten text, stickies, Mermaid diagrams) that the board converts
 * into drawn elements the next time it is open.
 */
export const BOARDS_DIR = path.join(path.dirname(DB_PATH), 'boards');

export type StickyColor = 'yellow' | 'green' | 'blue' | 'pink' | 'orange';

export interface BoardItem {
  id: string;
  type: 'heading' | 'text' | 'sticky' | 'mermaid';
  text: string;
  color?: StickyColor;
  at: string;
}

export interface Board {
  rev: number;
  nodeId: string;
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  pending: BoardItem[];
  updatedAt: string;
}

const ID = /^[A-Za-z0-9-]{4,80}$/;

export function boardPath(nodeId: string): string {
  if (!ID.test(nodeId)) throw new Error('Invalid board id.');
  return path.join(BOARDS_DIR, `${nodeId}.json`);
}

export function readBoard(nodeId: string): Board | null {
  const file = boardPath(nodeId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Board;
}

function emptyBoard(nodeId: string): Board {
  return { rev: 0, nodeId, elements: [], appState: {}, files: {}, pending: [], updatedAt: new Date().toISOString() };
}

function writeBoard(b: Board) {
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  const file = boardPath(b.nodeId);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(b));
  fs.renameSync(tmp, file);
}

const lockFor = (nodeId: string) => `${boardPath(nodeId)}.lock`;

/** Saves a browser edit, merging with whatever is on disk. Returns the merged board. */
export function saveBoard(
  nodeId: string,
  edit: { elements: SceneElement[]; appState?: Record<string, unknown>; files?: Record<string, unknown>; consumed?: string[] },
): Board {
  return withLock(() => {
    const cur = readBoard(nodeId) ?? emptyBoard(nodeId);
    const consumed = new Set(edit.consumed ?? []);
    const next: Board = {
      ...cur,
      rev: cur.rev + 1,
      elements: mergeElements(cur.elements, edit.elements),
      appState: edit.appState ?? cur.appState,
      files: { ...cur.files, ...edit.files },
      pending: cur.pending.filter((p) => !consumed.has(p.id)),
      updatedAt: new Date().toISOString(),
    };
    writeBoard(next);
    return next;
  }, lockFor(nodeId));
}

/** Claude's way onto a board: queue items to be drawn when the board is next open. */
export function addPending(nodeId: string, items: Omit<BoardItem, 'id' | 'at'>[]): Board {
  return withLock(() => {
    const cur = readBoard(nodeId) ?? emptyBoard(nodeId);
    const at = new Date().toISOString();
    const next: Board = {
      ...cur,
      rev: cur.rev + 1,
      pending: [...cur.pending, ...items.map((it) => ({ ...it, id: crypto.randomUUID(), at }))],
      updatedAt: at,
    };
    writeBoard(next);
    return next;
  }, lockFor(nodeId));
}

export function deleteBoard(nodeId: string): void {
  withLock(() => fs.rmSync(boardPath(nodeId), { force: true }), lockFor(nodeId));
}

export interface BoardSummary {
  nodeId: string;
  rev: number;
  updatedAt: string;
  elements: number;
  pending: number;
}

export function listBoards(): BoardSummary[] {
  if (!fs.existsSync(BOARDS_DIR)) return [];
  return fs
    .readdirSync(BOARDS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readBoard(f.slice(0, -5)))
    .filter((b): b is Board => !!b)
    .map((b) => ({ nodeId: b.nodeId, rev: b.rev, updatedAt: b.updatedAt, elements: b.elements.filter((e) => !e.isDeleted).length, pending: b.pending.length }));
}

/** Everything written on a board, top to bottom, so Claude can read it back. */
export function boardText(b: Board): string[] {
  const texts = b.elements
    .filter((e) => !e.isDeleted && e.type === 'text' && typeof e.text === 'string' && e.text.trim())
    .sort((a, c) => (a.y ?? 0) - (c.y ?? 0) || (a.x ?? 0) - (c.x ?? 0))
    .map((e) => (e.text as string).trim());
  const queued = b.pending.map((p) => `${p.type === 'mermaid' ? '[diagram, not drawn yet]\n' : '[not drawn yet] '}${p.text}`);
  return [...texts, ...queued];
}
