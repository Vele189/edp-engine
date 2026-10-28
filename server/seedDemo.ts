import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildDemo } from './demo';

/** Writes a fresh demo database. Refuses to touch the real one. */
const real = path.join(os.homedir(), '.edp-engine', 'db.json');
const target = path.resolve(process.env.EDP_DEMO_DB ?? path.join(os.homedir(), '.edp-engine', 'demo.json'));

if (target === path.resolve(real)) {
  console.error(`Refusing to write demo data over your real database (${real}).`);
  process.exit(1);
}

const db = buildDemo();
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify({ rev: 1, db }, null, 2));
console.log(`Demo written to ${target}: ${db.projects.length} projects, ${db.notes.length} notes, ${db.links.length} links, ${db.sessions.length} sessions.`);
