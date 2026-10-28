import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Connect, Plugin } from 'vite';
import { DB_PATH, exists, putIfRev, read } from './fileStore';
import { BOARDS_DIR, listBoards, readBoard, saveBoard } from './boards';
import { browse, folderContext, listFolders } from './workspace';

/**
 * Serves the shared database to the browser:
 *   GET  /api/db      → { rev, db | null }  (null until the file exists, so the app can migrate IndexedDB data)
 *   PUT  /api/db      ← { baseRev, db }     → { rev } or 409 { rev, db }
 *   GET  /api/events  → server-sent events with the new rev whenever the file changes (e.g. from MCP),
 *                       plus `event: board` messages { id, rev } when a board file changes
 *   GET  /api/boards           → summaries of every board
 *   GET  /api/boards/:nodeId   → the board, or 404
 *   PUT  /api/boards/:nodeId   ← { elements, appState, files, consumed } → merged board
 *   GET  /api/browse?dir=      → subfolders of a folder in the home directory (folder picker)
 *   GET  /api/workspace        → { root, folders } for the chosen workspace root
 *   GET  /api/workspace/context?folder= → README, top-level files, recent files, git
 */
function api(): Connect.NextHandleFunction {
  const clients = new Set<ServerResponse>();
  fs.watchFile(DB_PATH, { interval: 400 }, () => {
    if (!exists()) return;
    const { rev } = read();
    for (const c of clients) c.write(`data: ${rev}\n\n`);
  }).unref();

  // Board files change from the browser and from Claude (MCP); tell open boards.
  fs.mkdirSync(BOARDS_DIR, { recursive: true });
  const timers = new Map<string, NodeJS.Timeout>();
  fs.watch(BOARDS_DIR, (_event, file) => {
    if (!file?.endsWith('.json')) return;
    const id = file.slice(0, -5);
    clearTimeout(timers.get(id));
    timers.set(
      id,
      setTimeout(() => {
        const b = readBoard(id);
        if (!b) return;
        for (const c of clients) c.write(`event: board\ndata: ${JSON.stringify({ id, rev: b.rev })}\n\n`);
      }, 80),
    );
  }).unref();

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(body));
  };

  const body = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => resolve(data));
      req.on('error', reject);
    });

  return async (req, res, next) => {
    const url = req.url?.split('?')[0];
    const query = new URLSearchParams(req.url?.split('?')[1] ?? '');
    try {
      if (url === '/api/db' && req.method === 'GET') {
        const snap = read();
        return json(res, 200, { rev: snap.rev, db: exists() ? snap.db : null, demo: process.env.EDP_DEMO === '1' });
      }
      if (url === '/api/db' && req.method === 'PUT') {
        const { baseRev, db } = JSON.parse(await body(req));
        const result = putIfRev(baseRev, db);
        return result.ok ? json(res, 200, { rev: result.rev }) : json(res, 409, result.current);
      }
      if (url === '/api/boards' && req.method === 'GET') return json(res, 200, listBoards());
      if (url === '/api/browse') {
        try {
          return json(res, 200, browse(query.get('dir') ?? undefined));
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      }
      if (url === '/api/workspace' || url === '/api/workspace/context') {
        const root = read().db.settings.workspaceRoot;
        if (!root) return json(res, 200, { root: null, folders: [] });
        try {
          if (url === '/api/workspace') return json(res, 200, { root, folders: listFolders(root) });
          return json(res, 200, await folderContext(root, query.get('folder') ?? ''));
        } catch (e) {
          return json(res, 400, { error: (e as Error).message });
        }
      }
      const board = url?.match(/^\/api\/boards\/([A-Za-z0-9-]{4,80})$/);
      if (board && req.method === 'GET') {
        const b = readBoard(board[1]);
        return b ? json(res, 200, b) : json(res, 404, { error: 'No board yet.' });
      }
      if (board && req.method === 'PUT') {
        return json(res, 200, saveBoard(board[1], JSON.parse(await body(req))));
      }
      if (url === '/api/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(`data: ${read().rev}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
    } catch (e) {
      return json(res, 500, { error: (e as Error).message });
    }
    next();
  };
}

/** Excalidraw's handwritten fonts, served locally so boards work offline (no CDN). */
const FONTS = path.resolve('node_modules/@excalidraw/excalidraw/dist/prod/fonts');

function excalidrawAssets(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const m = req.url?.split('?')[0].match(/^\/excalidraw-assets\/fonts\/(.+)$/);
    if (!m) return next();
    const file = path.resolve(FONTS, decodeURIComponent(m[1]));
    if (!file.startsWith(FONTS + path.sep) || !fs.existsSync(file)) {
      res.statusCode = 404;
      return res.end();
    }
    res.setHeader('Content-Type', file.endsWith('.woff2') ? 'font/woff2' : 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    fs.createReadStream(file).pipe(res);
  };
}

export function edpApi(): Plugin {
  return {
    name: 'edp-api',
    configureServer(server) {
      server.middlewares.use(excalidrawAssets());
      server.middlewares.use(api());
    },
    configurePreviewServer(server) {
      server.middlewares.use(excalidrawAssets());
      server.middlewares.use(api());
    },
  };
}
