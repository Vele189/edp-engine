import { useEffect, useState } from 'react';
import { updateProject } from '../engine/engine';
import type { Project } from '../engine/types';
import { useStore } from '../store';
import { ago } from '../components/ui';
import { useWorkspace } from './Projects';

interface FolderContext {
  path: string;
  readme: string;
  tree: string[];
  recent: { file: string; modifiedAt: string }[];
  git: { branch: string; lastCommit: string } | null;
  error?: string;
}

/** The project's home on disk: where it lives, what changed lately, and what its README says. */
export function FolderSection({ p }: { p: Project }) {
  const { db, act } = useStore();
  const { root, folders } = useWorkspace();
  const [ctx, setCtx] = useState<FolderContext | null>(null);

  useEffect(() => {
    setCtx(null);
    if (!p.folder || !root) return;
    fetch(`/api/workspace/context?folder=${encodeURIComponent(p.folder)}`)
      .then((r) => r.json())
      .then(setCtx)
      .catch(() => setCtx({ error: 'Could not read the folder.' } as FolderContext));
  }, [p.folder, root]);

  if (!root) {
    return (
      <section className="card-section">
        <h3>Folder</h3>
        <p className="muted small">
          Choose your projects folder in <a href="#projects">Projects</a> to link this project to its files.
        </p>
      </section>
    );
  }

  const free = folders.filter((f) => f.folder === p.folder || !db.projects.some((x) => x.folder === f.folder));
  const setFolder = (folder: string) => act((d, now) => updateProject(d, p.id, { folder: folder || undefined }, now));

  return (
    <section className="card-section">
      <h3>Folder</h3>
      <select value={p.folder ?? ''} onChange={(e) => setFolder(e.target.value)} aria-label="Project folder">
        <option value="">Not linked to a folder</option>
        {free.map((f) => (
          <option key={f.folder} value={f.folder}>
            {f.folder}
          </option>
        ))}
      </select>
      {ctx?.error && <p className="notice">{ctx.error}</p>}
      {ctx && !ctx.error && (
        <div className="folder-ctx">
          <p>
            <code className="path">{ctx.path}</code>
          </p>
          {ctx.git && (
            <p className="small">
              <strong>{ctx.git.branch}</strong> · last commit {ctx.git.lastCommit}
            </p>
          )}
          {ctx.recent.length > 0 && (
            <>
              <span className="label">Recently changed</span>
              <ul className="recent-files">
                {ctx.recent.slice(0, 6).map((r) => (
                  <li key={r.file}>
                    <code>{r.file}</code> <span className="muted small">{ago(r.modifiedAt)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {ctx.readme && (
            <details>
              <summary>README</summary>
              <pre className="readme">{ctx.readme}</pre>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
