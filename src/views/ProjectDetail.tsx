import { useState } from 'react';
import { EDGES, REASON_LABELS, getProject, updateProject } from '../engine/engine';
import type { Layer, ReentryCard, State } from '../engine/types';
import { useStore } from '../store';
import { describeEdge, edgesOf } from '../engine/graph';
import { TransitionDialog } from '../components/TransitionDialog';
import { AutoText, LAYER_LABEL, NextActionFields, STATE_LABEL, useUi } from '../components/ui';
import { Icon } from '../components/icons';
import { FolderSection } from './ProjectFolder';

/**
 * A project as a full page rather than a sheet: titles and notes get the full width,
 * and every text field wraps and grows instead of scrolling sideways.
 */
export function ProjectPage({ id }: { id: string }) {
  const { db, act } = useStore();
  const { openFirewall } = useUi();
  const [moving, setMoving] = useState<State | null>(null);
  const [newFile, setNewFile] = useState('');
  const p = db.projects.find((x) => x.id === id);
  if (!p) {
    return (
      <section className="panel">
        <p className="muted">This project no longer exists.</p>
        <a href="#studio">Back to Studio</a>
      </section>
    );
  }
  const edges = edgesOf(db, p.id);

  const patch = (fields: Parameters<typeof updateProject>[2]) => act((d, now) => updateProject(d, id, fields, now));
  const setCard = (c: Partial<ReentryCard>) => patch({ card: { ...getProject(db, id).card, ...c } });
  const text = (k: 'outcome' | 'currentState' | 'lastThought' | 'blocker' | 'definitionOfDone', label: string, singleLine = true) => (
    <label>
      <span>{label}</span>
      <AutoText singleLine={singleLine} value={p.card[k]} onChange={(v) => setCard({ [k]: v })} />
    </label>
  );

  const goTo = (to: State) => {
    if (to === 'active' && (p.state === 'cooling' || p.state === 'incubator')) openFirewall(p.id);
    else setMoving(to);
  };

  return (
    <div className="project-page">
      <button className="plain back" onClick={() => history.back()}>
        <Icon name="chevron" size={18} />
        Back
      </button>

      <AutoText singleLine className="title-field" value={p.title} onChange={(v) => patch({ title: v })} aria-label="Title" />

      <div className="meta">
        <span className={`pill s-${p.state}`}>{STATE_LABEL[p.state]}</span>
        <select value={p.layer} onChange={(e) => patch({ layer: e.target.value as Layer })} aria-label="Layer">
          {(['anchor', 'studio', 'garden'] as const).map((l) => (
            <option key={l} value={l}>
              {LAYER_LABEL[l]}
            </option>
          ))}
        </select>
        <label className="inline">
          <span>Deadline</span>
          <input type="date" value={p.deadline ?? ''} onChange={(e) => patch({ deadline: e.target.value || undefined })} />
        </label>
      </div>

      <div className="moves">
        <a className="button-link" href={`#board:${p.id}`}>
          Open board
        </a>
        {EDGES[p.state].map((to) => (
          <button key={to} onClick={() => goTo(to)}>
            → {STATE_LABEL[to]}
            {to === 'active' && (p.state === 'cooling' || p.state === 'incubator') ? ' (firewall)' : ''}
          </button>
        ))}
      </div>

      <div className="project-grid">
        <div className="project-main">
          <FolderSection p={p} />
          <section className="card-section">
            <label>
              <span>Why it matters</span>
              <AutoText value={p.why} onChange={(v) => patch({ why: v })} />
            </label>
          </section>

          {p.experiment && (
            <section className="card-section">
              <h3>Experiment</h3>
              <p className="prose">
                <strong>Question:</strong> {p.experiment.question} · <strong>Cap:</strong> {p.experiment.timeCapMin} min
              </p>
              <label>
                <span>Result</span>
                <AutoText value={p.experiment.result ?? ''} onChange={(v) => patch({ experiment: { ...p.experiment!, result: v } })} />
              </label>
            </section>
          )}

          <section className="card-section">
            <h3>Re-entry card</h3>
            {text('outcome', 'Desired outcome')}
            {text('currentState', 'Current state', false)}
            <NextActionFields value={p.card.next} onChange={(next) => setCard({ next })} />
            <div>
              <span className="label">Files</span>
              <ul className="files">
                {p.card.files.map((f) => (
                  <li key={f}>
                    <code>{f}</code>
                    <button className="ghost small" onClick={() => setCard({ files: p.card.files.filter((x) => x !== f) })}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
              <form
                className="inline-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (newFile.trim()) setCard({ files: [...p.card.files, newFile.trim()] });
                  setNewFile('');
                }}
              >
                <input value={newFile} onChange={(e) => setNewFile(e.target.value)} placeholder="Path or URL of the exact file" aria-label="Add a file" />
                <button type="submit">Add</button>
              </form>
            </div>
            {text('lastThought', 'Last thought', false)}
            {text('blocker', 'Blocker', false)}
            {text('definitionOfDone', 'Definition of done', false)}
          </section>
        </div>

        <aside className="project-side">
          {p.firewall && (
            <section className="card-section">
              <h3>Firewall ({p.firewall.decision})</h3>
              <dl className="gates">
                <dt>Reality</dt>
                <dd>{p.firewall.reality || '—'}</dd>
                <dt>Evidence</dt>
                <dd>{p.firewall.evidence || '—'}</dd>
                <dt>Cost</dt>
                <dd>{p.firewall.cost || '—'}</dd>
                <dt>Exit</dt>
                <dd>{p.firewall.exit || '—'}</dd>
              </dl>
            </section>
          )}

          {p.completion && (
            <section className="card-section">
              <h3>Completed</h3>
              <p className="prose">{p.completion}</p>
            </section>
          )}

          <section className="card-section">
            <h3>Connections ({edges.length})</h3>
            {edges.length === 0 && <p className="muted small">Not linked to anything in the brain yet.</p>}
            <ul className="edges">
              {edges.map((e) => (
                <li key={e.link.id}>
                  <a href={`#graph:${e.other.id}`}>{describeEdge(e)}</a>
                  <p className="muted small">{e.link.why}</p>
                </li>
              ))}
            </ul>
            <a className="small" href={`#graph:${p.id}`}>
              View in graph
            </a>
          </section>

          {p.history.length > 0 && (
            <section className="card-section">
              <details>
                <summary>History ({p.history.length})</summary>
                <ol className="history">
                  {p.history.map((t, i) => (
                    <li key={i}>
                      {t.at.slice(0, 10)} · {STATE_LABEL[t.from]} → {STATE_LABEL[t.to]} · {REASON_LABELS[t.reason]}
                      {t.note && ` — ${t.note}`}
                    </li>
                  ))}
                </ol>
              </details>
            </section>
          )}
        </aside>
      </div>

      {moving && <TransitionDialog p={p} to={moving} onClose={() => setMoving(null)} />}
    </div>
  );
}
