import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * The workspace: the folder a person chooses as the root of their projects.
 * The engine only ever reads here, and only names, dates, READMEs and git metadata;
 * hidden files (.env and friends) and heavy build folders are never opened.
 */

const SKIP = new Set(['node_modules', 'dist', 'build', 'out', 'target', '.git', '.next', '.venv', 'venv', '__pycache__', 'coverage']);
/** Generated files that say nothing about the work itself. */
const NOISE = /(\.tsbuildinfo|\.log|\.map|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock)$/;
const MARKERS = ['.git', 'package.json', 'README.md', 'Cargo.toml', 'pyproject.toml', 'go.mod', 'index.html'];

const hidden = (name: string) => name.startsWith('.');

export const expandHome = (p: string) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

/** Folders the engine may read: the user's home, plus any listed in EDP_ALLOW_DIRS (colon-separated). */
const allowedBases = () => [os.homedir(), ...(process.env.EDP_ALLOW_DIRS ?? '').split(':').filter(Boolean).map((d) => path.resolve(d))];

/** A folder the browser may navigate: an existing directory inside an allowed base (normally home). */
export function safeDir(input: string): string {
  const dir = path.resolve(expandHome(input));
  if (!allowedBases().some((base) => dir === base || dir.startsWith(base + path.sep))) {
    throw new Error('Only folders inside your home folder can be used.');
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a folder: ${dir}`);
  return dir;
}

/** Resolves a project folder under the root, refusing anything that escapes it. */
export function projectDir(root: string, folder: string): string {
  const base = safeDir(root);
  const dir = path.resolve(base, folder);
  if (!dir.startsWith(base + path.sep)) throw new Error('That folder is outside the workspace.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`No folder "${folder}" in the workspace.`);
  return dir;
}

export interface BrowseResult {
  dir: string;
  parent: string | null;
  folders: string[];
}

/** Subfolders of a directory, for the folder picker. */
export function browse(input?: string): BrowseResult {
  const dir = safeDir(input || os.homedir());
  const folders = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !hidden(e.name) && !SKIP.has(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const parent = dir === os.homedir() ? null : path.dirname(dir);
  return { dir, parent, folders };
}

function readmeOf(dir: string, max: number): string {
  const name = fs.readdirSync(dir).find((f) => /^readme(\.md|\.txt)?$/i.test(f));
  if (!name) return '';
  const text = fs.readFileSync(path.join(dir, name), 'utf8');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Cuts at a word boundary so summaries never end mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max * 0.6)).replace(/[\s,.;:]+$/, '')}…`;
}

/** The first prose line of a README, skipping headings, badges, HTML, code and language-switcher link rows. */
function summaryOf(readme: string): string {
  const lines = readme.split('\n').map((l) => l.trim());
  const prose = (l: string) =>
    !!l &&
    !/^(#|!\[|\[!|<|```|>|\||-{3,}|[-*] )/.test(l) &&
    (l.match(/\]\(/g) ?? []).length < 3 &&
    l.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[^\p{L}]/gu, '').length >= 20;
  const start = lines.findIndex(prose);
  if (start < 0) return '';
  // Markdown wraps a paragraph over several lines; take the whole paragraph.
  let end = start;
  while (end + 1 < lines.length && lines[end + 1] && !/^(#|```|[-*] |\|)/.test(lines[end + 1])) end++;
  const para = lines.slice(start, end + 1).join(' ');
  return clip(para.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, ''), 200);
}

/** Most recent modification among a folder's visible top-level entries. */
function lastTouched(dir: string): string {
  let latest = fs.statSync(dir).mtimeMs;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (hidden(e.name) || SKIP.has(e.name)) continue;
    try {
      latest = Math.max(latest, fs.statSync(path.join(dir, e.name)).mtimeMs);
    } catch {
      /* broken symlink */
    }
  }
  return new Date(latest).toISOString();
}

export interface WorkspaceFolder {
  folder: string;
  path: string;
  modifiedAt: string;
  markers: string[];
  summary: string;
}

export function listFolders(root: string): WorkspaceFolder[] {
  const base = safeDir(root);
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !hidden(e.name) && !SKIP.has(e.name))
    .map((e) => {
      const dir = path.join(base, e.name);
      const entries = new Set(fs.readdirSync(dir));
      return {
        folder: e.name,
        path: dir,
        modifiedAt: lastTouched(dir),
        markers: MARKERS.filter((m) => entries.has(m)),
        summary: summaryOf(readmeOf(dir, 4000)),
      };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

const run = promisify(execFile);

async function git(dir: string): Promise<{ branch: string; lastCommit: string } | null> {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;
  try {
    const opts = { cwd: dir, timeout: 3000 };
    const [{ stdout: branch }, { stdout: last }] = await Promise.all([
      run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], opts),
      run('git', ['log', '-1', '--format=%cr: %s'], opts),
    ]);
    return { branch: branch.trim(), lastCommit: last.trim() };
  } catch {
    return null;
  }
}

/** Recently modified files (depth ≤ 3), skipping hidden and build folders. */
function recentFiles(dir: string, limit: number): { file: string; modifiedAt: string }[] {
  const found: { file: string; mtime: number }[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || found.length > 4000) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (hidden(e.name) || SKIP.has(e.name)) continue;
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && !NOISE.test(e.name)) found.push({ file: path.relative(dir, p), mtime: fs.statSync(p).mtimeMs });
      } catch {
        /* unreadable entry */
      }
    }
  };
  walk(dir, 1);
  return found
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((f) => ({ file: f.file, modifiedAt: new Date(f.mtime).toISOString() }));
}

export interface FolderContext {
  path: string;
  readme: string;
  tree: string[];
  recent: { file: string; modifiedAt: string }[];
  git: { branch: string; lastCommit: string } | null;
}

/** What an agent needs to orient itself in a project folder before reading code itself. */
export async function folderContext(root: string, folder: string): Promise<FolderContext> {
  const dir = projectDir(root, folder);
  const tree = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => !hidden(e.name) && !SKIP.has(e.name))
    .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
    .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || a.localeCompare(b))
    .slice(0, 60);
  return { path: dir, readme: readmeOf(dir, 2500), tree, recent: recentFiles(dir, 10), git: await git(dir) };
}
