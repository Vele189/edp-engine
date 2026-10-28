import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyDb, isoDate, migrate } from '../src/engine/engine';
import type { Db } from '../src/engine/types';

/**
 * The single source of truth shared by the web app (via the Vite API) and the MCP server.
 * Stored as { rev, db } so writers can detect each other's changes.
 */
export const DB_PATH = process.env.EDP_DB ?? path.join(os.homedir(), '.edp-engine', 'db.json');
const LOCK = `${DB_PATH}.lock`;

export interface Snapshot {
  rev: number;
  db: Db;
}

export function exists(): boolean {
  return fs.existsSync(DB_PATH);
}

export function read(): Snapshot {
  if (!exists()) return { rev: 0, db: emptyDb() };
  const raw = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  return { rev: raw.rev ?? 0, db: migrate(raw.db) };
}

/** Cross-process lock: mkdir is atomic. Stale locks (crashed writer) expire after 5s. */
export function withLock<T>(fn: () => T, lock = LOCK): T {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        /* lock vanished between checks */
      }
      if (Date.now() > deadline) throw new Error(`${path.basename(lock, '.lock')} is locked by another writer.`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

function write(snap: Snapshot) {
  const dir = path.dirname(DB_PATH);
  // One backup per day of the previous state, so a bad edit is recoverable.
  if (exists()) {
    const backups = path.join(dir, 'backups');
    const daily = path.join(backups, `${isoDate(new Date())}.json`);
    if (!fs.existsSync(daily)) {
      fs.mkdirSync(backups, { recursive: true });
      fs.copyFileSync(DB_PATH, daily);
    }
  }
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

/** Applies an engine operation to the latest state. Engine errors propagate untouched. */
export function mutate(op: (db: Db, now: Date) => Db): Snapshot {
  return withLock(() => {
    const cur = read();
    const next = { rev: cur.rev + 1, db: op(cur.db, new Date()) };
    write(next);
    return next;
  });
}

/** Optimistic write from the browser: only succeeds if nobody wrote since `baseRev`. */
export function putIfRev(baseRev: number, db: Db): { ok: true; rev: number } | { ok: false; current: Snapshot } {
  return withLock(() => {
    const cur = read();
    if (cur.rev !== baseRev) return { ok: false as const, current: cur };
    const next = { rev: cur.rev + 1, db: migrate(db) };
    write(next);
    return { ok: true as const, rev: next.rev };
  });
}
