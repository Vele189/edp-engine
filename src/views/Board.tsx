import { CaptureUpdateAction, Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { parseMermaidToExcalidraw } from '@excalidraw/mermaid-to-excalidraw';
import { useCallback, useEffect, useRef, useState } from 'react';
import { mergeElements, type SceneElement } from '../board/merge';
import { nodeOf } from '../engine/graph';
import { useStore } from '../store';
import { Icon } from '../components/icons';

// Fonts are served locally (see server/apiPlugin.ts), so the board works offline.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw-assets/';

interface BoardItem {
  id: string;
  type: 'heading' | 'text' | 'sticky' | 'mermaid';
  text: string;
  color?: 'yellow' | 'green' | 'blue' | 'pink' | 'orange';
}
interface BoardFile {
  rev: number;
  elements: SceneElement[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  pending: BoardItem[];
}

const STICKY: Record<NonNullable<BoardItem['color']>, string> = {
  yellow: '#ffec99',
  green: '#b2f2bb',
  blue: '#a5d8ff',
  pink: '#fcc2d7',
  orange: '#ffd8a8',
};

/** Hard-wraps text so long plans stay readable inside a sticky of fixed width. */
function wrap(text: string, width: number): string {
  return text
    .split('\n')
    .map((para) => {
      const lines: string[] = [];
      let line = '';
      for (const word of para.split(/\s+/)) {
        if (line && (line + ' ' + word).length > width) {
          lines.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      lines.push(line);
      return lines.join('\n');
    })
    .join('\n');
}

/**
 * Draws Claude's queued items below whatever is already on the board:
 * headings and text in the handwritten font, stickies in rows of three, Mermaid as a hand-drawn diagram.
 */
async function drawPending(items: BoardItem[], existing: readonly SceneElement[]): Promise<SceneElement[]> {
  // Text is measured when created; measuring before the handwritten font loads clips it.
  await Promise.all([document.fonts.load('20px Excalifont'), document.fonts.load('36px Excalifont')]).catch(() => {});
  const live = existing.filter((e) => !e.isDeleted);
  const bottom = live.reduce((m, e) => Math.max(m, (e.y ?? 0) + (Number(e.height) || 0)), 0);
  const left = live.length ? live.reduce((m, e) => Math.min(m, e.x ?? 0), Infinity) : 0;
  let y = live.length ? bottom + 80 : 0;
  let col = 0;
  let rowHeight = 0;
  const out: SceneElement[] = [];
  const newRow = () => {
    if (col > 0) y += rowHeight + 30;
    col = 0;
    rowHeight = 0;
  };

  for (const item of items) {
    if (item.type === 'sticky') {
      const text = wrap(item.text, 23);
      const height = Math.max(120, text.split('\n').length * 25 + 50);
      const skeleton: ExcalidrawElementSkeleton = {
        type: 'rectangle',
        x: left + col * 340,
        y,
        width: 300,
        height,
        backgroundColor: STICKY[item.color ?? 'yellow'],
        fillStyle: 'solid',
        strokeColor: '#1e1e1e',
        roundness: { type: 3 },
        label: { text, fontSize: 20, textAlign: 'left', verticalAlign: 'top' },
      };
      out.push(...(convertToExcalidrawElements([skeleton]) as unknown as SceneElement[]));
      rowHeight = Math.max(rowHeight, height);
      col++;
      if (col === 3) newRow();
      continue;
    }
    newRow();
    if (item.type === 'heading' || item.type === 'text') {
      const big = item.type === 'heading';
      const text = big ? item.text : wrap(item.text, 70);
      const els = convertToExcalidrawElements([{ type: 'text', x: left, y, text, fontSize: big ? 36 : 20 }]) as unknown as SceneElement[];
      out.push(...els);
      y += (big ? 60 : text.split('\n').length * 25 + 30);
    } else {
      try {
        const { elements } = await parseMermaidToExcalidraw(item.text, { themeVariables: { fontSize: '18px' } });
        const els = convertToExcalidrawElements(elements, { regenerateIds: true }) as unknown as SceneElement[];
        const minX = Math.min(...els.map((e) => e.x ?? 0));
        const minY = Math.min(...els.map((e) => e.y ?? 0));
        const maxY = Math.max(...els.map((e) => (e.y ?? 0) + (Number(e.height) || 0)));
        for (const e of els) {
          e.x = (e.x ?? 0) - minX + left;
          e.y = (e.y ?? 0) - minY + y;
        }
        out.push(...els);
        y += maxY - minY + 60;
      } catch (err) {
        // A diagram that doesn't parse is kept as text, so nothing Claude wrote is lost.
        const els = convertToExcalidrawElements([
          { type: 'text', x: left, y, text: `Diagram (could not draw: ${(err as Error).message.split('\n')[0]})\n${item.text}`, fontSize: 16 },
        ]) as unknown as SceneElement[];
        out.push(...els);
        y += item.text.split('\n').length * 22 + 50;
      }
    }
  }
  return out;
}

const signature = (els: readonly SceneElement[]) => els.reduce((s, e) => s + e.version, 0) + ':' + els.length;
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;

export default function Board({ nodeId }: { nodeId: string }) {
  const { db } = useStore();
  const node = nodeOf(db, nodeId);
  const [initial, setInitial] = useState<BoardFile | null>(null);
  const [status, setStatus] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [theme, setTheme] = useState<'light' | 'dark'>(dark() ? 'dark' : 'light');
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const rev = useRef(0);
  const saved = useRef('');
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const busy = useRef(false);
  // Queued items already drawn (React dev mounts twice; live events can race the first load).
  const drawn = useRef(new Set<string>());

  const scene = () => (api.current?.getSceneElementsIncludingDeleted() ?? []) as unknown as SceneElement[];

  const apply = (els: SceneElement[]) => {
    api.current?.updateScene({ elements: els as never, captureUpdate: CaptureUpdateAction.NEVER });
    saved.current = signature(els);
  };

  const save = useCallback(async (consumed: string[] = []) => {
    if (!api.current) return;
    busy.current = true;
    setStatus('saving');
    try {
      const appState = api.current.getAppState();
      const res = await fetch(`/api/boards/${nodeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: scene(),
          appState: { viewBackgroundColor: appState.viewBackgroundColor, gridModeEnabled: appState.gridModeEnabled },
          files: api.current.getFiles(),
          consumed,
        }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const board = (await res.json()) as BoardFile;
      rev.current = board.rev;
      // Pick up anything Claude added while we were saving.
      const merged = mergeElements(scene(), board.elements);
      if (signature(merged) !== signature(scene())) apply(merged);
      saved.current = signature(scene());
      setStatus('saved');
    } catch {
      setStatus('error');
    } finally {
      busy.current = false;
    }
  }, [nodeId]);

  /** Fetches the board; draws any queued items from Claude and saves them as real elements. */
  const sync = useCallback(async () => {
    const res = await fetch(`/api/boards/${nodeId}`);
    if (res.status === 404) return null;
    const board = (await res.json()) as BoardFile;
    rev.current = board.rev;
    if (api.current) {
      const merged = mergeElements(scene(), board.elements);
      const fresh = board.pending.filter((p) => !drawn.current.has(p.id));
      for (const p of fresh) drawn.current.add(p.id);
      if (fresh.length) {
        apply([...mergeElements(scene(), board.elements), ...(await drawPending(fresh, mergeElements(scene(), board.elements)))]);
        await save(fresh.map((p) => p.id));
      } else if (signature(merged) !== signature(scene())) {
        apply(merged);
      }
    }
    return board;
  }, [nodeId, save]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch(`/api/boards/${nodeId}`);
      const board: BoardFile = res.status === 404 ? { rev: 0, elements: [], appState: {}, files: {}, pending: [] } : await res.json();
      if (!alive) return;
      rev.current = board.rev;
      saved.current = signature(board.elements);
      setInitial(board);
      setStatus('saved');
    })().catch(() => setStatus('error'));
    return () => {
      alive = false;
    };
  }, [nodeId]);

  // Draw queued items once the editor exists.
  const onApi = (a: ExcalidrawImperativeAPI) => {
    api.current = a;
    if (initial?.pending.length) setTimeout(() => sync(), 0);
  };

  // Live updates when Claude (or another tab) writes to this board.
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.addEventListener('board', (e) => {
      const { id, rev: r } = JSON.parse((e as MessageEvent).data);
      if (id === nodeId && r > rev.current && !busy.current) sync().catch(() => {});
    });
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onTheme = () => setTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onTheme);
    return () => {
      events.close();
      mq.removeEventListener('change', onTheme);
    };
  }, [nodeId, sync]);

  // Save shortly after the drawing changes (selection and scrolling don't count).
  const onChange = () => {
    if (signature(scene()) === saved.current) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => save(), 700);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <div className="board-page">
      <header className="board-head">
        <button className="plain back" onClick={() => history.back()}>
          <Icon name="chevron" size={18} />
          Back
        </button>
        <h1 className="board-title">{node ? node.title : 'Board'}</h1>
        <span className={`board-status ${status}`} role="status">
          {status === 'loading' ? 'Loading…' : status === 'saving' ? 'Saving…' : status === 'error' ? 'Not saved — is the app server running?' : 'Saved'}
        </span>
        {node && (
          <a className="small" href={`#graph:${node.id}`}>
            In graph
          </a>
        )}
      </header>
      <div className="board-canvas">
        {initial && (
          <Excalidraw
            excalidrawAPI={onApi}
            initialData={{
              elements: initial.elements as never,
              appState: { ...initial.appState, currentItemFontFamily: 5, currentItemRoughness: 1 },
              files: initial.files as never,
              scrollToContent: true,
            }}
            onChange={onChange}
            theme={theme}
            name={node?.title ?? 'Board'}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true } } }}
          />
        )}
      </div>
    </div>
  );
}
