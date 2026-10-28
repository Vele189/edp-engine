import { useEffect, useState } from 'react';
import { capture, updateProject } from '../engine/engine';
import { edgesOf } from '../engine/graph';
import type { Project } from '../engine/types';
import { useStore } from '../store';
import { Beacon, Modal, Problems, STATE_LABEL, ago } from '../components/ui';
import { Icon } from '../components/icons';

export interface WorkspaceFolder {
  folder: string;
  path: string;
  modifiedAt: string;
  markers: string[];
  summary: string;
}

/** The chosen workspace root and its project folders, refreshed when the root changes. */
export function useWorkspace() {
  const { db } = useStore();
  const root = db.settings.workspaceRoot;
  const [folders, setFolders] = useState<WorkspaceFolder[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!root) return setFolders([]);
    fetch('/api/workspace')
      .then((r) => r.json())
      .then((w) => {
        setFolders(w.folders ?? []);
        setError(w.error ?? '');
      })
      .catch(() => setError('Could not read the workspace.'));
  }, [root]);
  return { root, folders, error };
}

function useBoardCounts() {
  const [counts, setCounts] = useState(new Map<string, number>());
  useEffect(() => {
    fetch('/api/boards')
      .then((r) => r.json())
      .then((list: { nodeId: string; elements: number }[]) => setCounts(new Map(list.map((b) => [b.nodeId, b.elements]))))
      .catch(() => {});
  }, []);
  return counts;
}

const MARKER_LABEL: Record<string, string> = {
  '.git': 'git',
  'package.json': 'Node',
  'README.md': 'README',
  'Cargo.toml': 'Rust',
  'pyproject.toml': 'Python',
  'go.mod': 'Go',
  'index.html': 'Web',
};

export function Projects() {
  const { db, act } = useStore();
  const { root, folders, error } = useWorkspace();
  const boards = useBoardCounts();
  const [picking, setPicking] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const setRoot = (dir: string) => act((d) => ({ ...d, settings: { ...d.settings, workspaceRoot: dir } }));

  /** Tracking a folder captures it into the Inbox like any idea; nothing is promoted automatically. */
  const track = (f: WorkspaceFolder) => {
    let id = '';
    const errs = act((d, now) => {
      const next = capture(d, f.folder, f.summary, now);
      id = next.projects[0].id;
      return updateProject(next, id, { folder: f.folder }, now);
    });
    setProblems(errs);
    if (!errs.length) location.hash = `project:${id}`;
  };

  const loose = db.projects.filter((p) => !p.folder && p.state !== 'archived' && p.state !== 'completed');
  const free = folders.filter((f) => !db.projects.some((p) => p.folder === f.folder));

  if (!root) {
    return (
      <section className="panel empty-workspace">
        <Icon name="projects" size={36} />
        <h2>Where do your projects live?</h2>
        <p className="muted">
          Choose the folder that holds your projects, such as Documents. Each folder in it becomes a project here, with everything you plan for it, and
          Claude can use it to find a project's files when it needs context. The engine only reads folder names, dates and READMEs; it never changes your
          files.
        </p>
        <button className="primary" onClick={() => setPicking(true)}>
          Choose folder
        </button>
        {picking && <FolderPicker onClose={() => setPicking(false)} onPick={setRoot} />}
      </section>
    );
  }

  return (
    <div className="stack">
      <div className="workspace-bar">
        <span className="muted small">Workspace</span>
        <code>{root}</code>
        <button className="small" onClick={() => setPicking(true)}>
          Change
        </button>
      </div>
      {error && <p className="notice">{error}</p>}
      <Problems items={problems} />

      <div className="project-cards">
        {folders.map((f) => {
          const p = db.projects.find((x) => x.folder === f.folder);
          return <FolderCard key={f.folder} f={f} p={p} boardElements={p ? boards.get(p.id) : undefined} onTrack={() => track(f)} />;
        })}
      </div>
      {folders.length === 0 && <p className="muted">No folders in {root} yet.</p>}

      {loose.length > 0 && (
        <section className="panel">
          <header className="panel-head">
            <h2>Not in a folder</h2>
          </header>
          <p className="muted small">Ideas and obligations that don't have a project folder (yet). Link one when it gets a home.</p>
          {loose.map((p) => (
            <div key={p.id} className="row">
              <a className="row-main" href={`#project:${p.id}`}>
                <span className="row-title">{p.title}</span>
                <span className="row-sub">{STATE_LABEL[p.state]}</span>
              </a>
              {free.length > 0 && (
                <select
                  className="link-folder"
                  aria-label={`Link ${p.title} to a folder`}
                  value=""
                  onChange={(e) => e.target.value && act((d, now) => updateProject(d, p.id, { folder: e.target.value }, now))}
                >
                  <option value="">Link folder…</option>
                  {free.map((f) => (
                    <option key={f.folder} value={f.folder}>
                      {f.folder}
                    </option>
                  ))}
                </select>
              )}
            </div>
          ))}
        </section>
      )}
      {picking && <FolderPicker start={root} onClose={() => setPicking(false)} onPick={setRoot} />}
    </div>
  );
}

function FolderCard({ f, p, boardElements, onTrack }: { f: WorkspaceFolder; p?: Project; boardElements?: number; onTrack: () => void }) {
  const { db } = useStore();
  const notes = p ? edgesOf(db, p.id).filter((e) => e.other.kind === 'note').length : 0;
  const sessions = p ? db.sessions.filter((s) => s.projectId === p.id).length : 0;
  return (
    <article className={`project-card${p ? '' : ' untracked'}`}>
      <header>
        <Icon name="projects" size={20} />
        <h3 className="card-title">{f.folder}</h3>
        {p && <span className={`pill s-${p.state}`}>{STATE_LABEL[p.state]}</span>}
      </header>
      {f.summary && <p className="card-summary">{f.summary}</p>}
      {p && (p.state === 'active' || p.state === 'paused') && <Beacon next={p.card.next} />}
      <p className="card-meta">
        <span>touched {ago(f.modifiedAt)}</span>
        {f.markers.map((m) => (
          <span key={m} className="tag">
            {MARKER_LABEL[m] ?? m}
          </span>
        ))}
      </p>
      {p ? (
        <>
          <p className="card-meta">
            <span>{notes} note{notes === 1 ? '' : 's'}</span>
            <span>{sessions} session{sessions === 1 ? '' : 's'}</span>
            {boardElements !== undefined && <span>board · {boardElements} items</span>}
          </p>
          <div className="actions left">
            <a className="button-link small" href={`#project:${p.id}`}>
              Open
            </a>
            <a className="small" href={`#board:${p.id}`}>
              Board
            </a>
            <a className="small" href={`#graph:${p.id}`}>
              Graph
            </a>
          </div>
        </>
      ) : (
        <div className="actions left">
          <button className="small" onClick={onTrack}>
            Track this project
          </button>
          <span className="muted small">Adds it to the Inbox</span>
        </div>
      )}
    </article>
  );
}

/** Folder picker backed by the local server: only folders inside the home directory are listed. */
export function FolderPicker({ start, onPick, onClose }: { start?: string; onPick: (dir: string) => void; onClose: () => void }) {
  const [dir, setDir] = useState<string | undefined>(start);
  const [listing, setListing] = useState<{ dir: string; parent: string | null; folders: string[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    fetch(`/api/browse${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`)
      .then((r) => r.json())
      .then((b) => {
        if (b.error) setError(b.error);
        else {
          setListing(b);
          setError('');
        }
      })
      .catch(() => setError('Could not read folders.'));
  }, [dir]);

  return (
    <Modal title="Choose your projects folder" onClose={onClose}>
      {listing && (
        <>
          <p className="picker-path">
            <code>{listing.dir}</code>
          </p>
          <ul className="picker-list">
            {listing.parent && (
              <li>
                <button className="picker-row" onClick={() => setDir(listing.parent!)}>
                  <Icon name="chevron" size={16} /> Up one level
                </button>
              </li>
            )}
            {listing.folders.map((f) => (
              <li key={f}>
                <button className="picker-row" onClick={() => setDir(`${listing.dir}/${f}`)}>
                  <Icon name="projects" size={18} /> {f}
                </button>
              </li>
            ))}
            {listing.folders.length === 0 && <li className="muted small">No subfolders here.</li>}
          </ul>
        </>
      )}
      {error && <p className="notice">{error}</p>}
      <div className="actions">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={!listing}
          onClick={() => {
            if (listing) onPick(listing.dir);
            onClose();
          }}
        >
          Use {listing ? listing.dir.split('/').pop() : 'this folder'}
        </button>
      </div>
    </Modal>
  );
}
