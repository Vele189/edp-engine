import { del, get } from 'idb-keyval';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { EngineError, emptyDb, migrate } from './engine/engine';
import type { Db } from './engine/types';

/** Where v0.x kept data, before the shared file store; migrated once and then removed. */
const LEGACY_IDB_KEY = 'edp-engine-db';

type Op = (db: Db, now: Date) => Db;

interface Store {
  db: Db;
  /** Applies an engine operation. Returns rule violations instead of throwing. */
  act: (op: Op) => string[];
  replace: (db: Db) => void;
  /** Running on the demo database (`npm run demo`). */
  demo: boolean;
}

const Ctx = createContext<Store | null>(null);

async function fetchSnapshot(): Promise<{ rev: number; db: Db | null; demo?: boolean }> {
  const res = await fetch('/api/db');
  if (!res.ok) throw new Error(`GET /api/db ${res.status}`);
  return res.json();
}

async function put(baseRev: number, db: Db): Promise<{ ok: true; rev: number } | { ok: false; rev: number; db: Db }> {
  const res = await fetch('/api/db', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ baseRev, db }),
  });
  if (res.status === 409) return { ok: false, ...(await res.json()) };
  if (!res.ok) throw new Error(`PUT /api/db ${res.status}`);
  return { ok: true, rev: (await res.json()).rev };
}

/**
 * The database lives in ~/.edp-engine/db.json (shared with the MCP server).
 * Edits apply locally at once, then sync in order; if someone else (e.g. Claude via MCP)
 * wrote in between, the same operation is re-applied on top of their version.
 */
export function StoreProvider({ children }: { children: ReactNode }) {
  const [db, setDb] = useState<Db | null>(null);
  const [error, setError] = useState('');
  const [demo, setDemo] = useState(false);
  const local = useRef<Db | null>(null);
  const server = useRef<{ rev: number; db: Db }>({ rev: 0, db: emptyDb() });
  const queue = useRef<Op[]>([]);
  const syncing = useRef(false);

  const show = (next: Db) => {
    local.current = next;
    setDb(next);
  };

  const drain = useCallback(async () => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      while (queue.current.length) {
        const op = queue.current[0];
        for (let attempt = 0; attempt < 3; attempt++) {
          let next: Db;
          try {
            next = op(server.current.db, new Date());
          } catch (e) {
            if (!(e instanceof EngineError)) throw e;
            break; // No longer valid on the newer state; drop it.
          }
          const result = await put(server.current.rev, next);
          if (result.ok) {
            server.current = { rev: result.rev, db: next };
            break;
          }
          server.current = { rev: result.rev, db: migrate(result.db) };
        }
        queue.current.shift();
      }
      show(server.current.db);
      setError('');
    } catch (e) {
      queue.current = [];
      setError(`Could not save: ${(e as Error).message}. Is the engine server running?`);
    } finally {
      syncing.current = false;
    }
  }, []);

  const refresh = useCallback(async () => {
    if (queue.current.length || syncing.current) return;
    const snap = await fetchSnapshot();
    if (snap.db && snap.rev !== server.current.rev) {
      server.current = { rev: snap.rev, db: migrate(snap.db) };
      show(server.current.db);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const snap = await fetchSnapshot();
        setDemo(!!snap.demo);
        // Bring over anything this browser saved before the file store, unless the file already has real data.
        const fileEmpty = !snap.db || (snap.db.projects.length === 0 && snap.db.sessions.length === 0);
        // Never in demo mode: that would move real browser data into the demo file.
        const legacy = fileEmpty && !snap.demo ? await get<Db>(LEGACY_IDB_KEY).catch(() => undefined) : undefined;
        if (snap.db && !legacy) {
          server.current = { rev: snap.rev, db: migrate(snap.db) };
          show(server.current.db);
          return;
        }
        const initial = legacy ? migrate(legacy) : emptyDb();
        const result = await put(snap.rev, initial);
        // Losing the race (another tab, or React StrictMode's double mount) just means adopting the winner's data.
        server.current = result.ok ? { rev: result.rev, db: initial } : { rev: result.rev, db: migrate(result.db) };
        if (result.ok && legacy) await del(LEGACY_IDB_KEY).catch(() => {});
        show(server.current.db);
      } catch (e) {
        setError(`Could not load the engine database: ${(e as Error).message}. Start it with "npm run dev".`);
      }
    })();

    const events = new EventSource('/api/events');
    events.onmessage = (e) => {
      if (Number(e.data) !== server.current.rev) refresh().catch(() => {});
    };
    return () => events.close();
  }, [refresh]);

  const act = useCallback(
    (op: Op) => {
      try {
        show(op(local.current!, new Date()));
      } catch (e) {
        if (e instanceof EngineError) return e.problems;
        throw e;
      }
      queue.current.push(op);
      drain();
      return [];
    },
    [drain],
  );

  const replace = useCallback(
    (next: Db) => {
      act(() => next);
    },
    [act],
  );

  if (!db) return error ? <p className="fatal">{error}</p> : null;
  return (
    <Ctx.Provider value={{ db, act, replace, demo }}>
      {error && <p className="fatal">{error}</p>}
      {children}
    </Ctx.Provider>
  );
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore outside StoreProvider');
  return s;
}

export function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export function exportJson(db: Db) {
  download(`edp-engine-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(db, null, 2), 'application/json');
}

export async function importJson(file: File): Promise<Db> {
  const data = JSON.parse(await file.text());
  if (![1, 2, 3].includes(data?.version) || !Array.isArray(data.projects)) throw new Error('Not an EDP Engine export.');
  return migrate(data);
}
