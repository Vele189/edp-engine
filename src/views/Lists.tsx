import { useState } from 'react';
import { activeStudio, hoursCooling, stalePaused } from '../engine/engine';
import type { Project, State } from '../engine/types';
import { useStore } from '../store';
import { TransitionDialog } from '../components/TransitionDialog';
import { ProjectRow, STATE_LABEL, ago, useUi } from '../components/ui';
import { Icon } from '../components/icons';

function useMove() {
  const [move, setMove] = useState<{ p: Project; to: State } | null>(null);
  const dialog = move && <TransitionDialog p={move.p} to={move.to} onClose={() => setMove(null)} />;
  return [(p: Project, to: State) => setMove({ p, to }), dialog] as const;
}

export function Inbox() {
  const { db } = useStore();
  const [go, dialog] = useMove();
  const items = db.projects.filter((p) => p.state === 'inbox');
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Inbox ({items.length})</h2>
      </header>
      <p className="muted">Captured, not yet assessed. No implicit promise to execute. Sort later, during the weekly reset.</p>
      {items.length === 0 && <p className="muted">Empty. Capture anything with the bar at the top (press /).</p>}
      {items.map((p) => (
        <ProjectRow
          key={p.id}
          p={p}
          extra={
            <>
              <span className="muted small">{ago(p.createdAt)}</span>
              <button className="small" onClick={() => go(p, 'experiment')} title="Small reversible test with a time cap">
                Experiment
              </button>
              <button className="small" onClick={() => go(p, 'cooling')} title="Substantial commitment proposed">
                Cool down
              </button>
              <button className="small ghost" onClick={() => go(p, 'archived')}>
                Archive
              </button>
            </>
          }
        />
      ))}
      {dialog}
    </section>
  );
}

export function Studio() {
  const { db } = useStore();
  const { openFirewall } = useUi();
  const [go, dialog] = useMove();
  const now = new Date();
  const by = (s: State, layer?: Project['layer']) =>
    db.projects.filter((p) => p.state === s && (!layer || p.layer === layer));
  const studio = activeStudio(db);
  const slots = Math.max(0, db.settings.activeLimit - studio.length);
  const stale = new Set(stalePaused(db, now).map((p) => p.id));

  return (
    <div className="columns">
      <section className="panel">
        <header className="panel-head">
          <h2>Layer A: Anchors</h2>
        </header>
        <p className="muted small">Non-negotiable obligations. They don’t count toward the trio.</p>
        {by('active', 'anchor').map((p) => (
          <ProjectRow key={p.id} p={p} />
        ))}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>
            Layer B: Active Studio {studio.length}/{db.settings.activeLimit}
          </h2>
        </header>
        <p className="muted small">One deep-work build, one creative workstream, one low-friction flexible workstream.</p>
        {studio.map((p) => (
          <ProjectRow
            key={p.id}
            p={p}
            extra={
              <button className="small" onClick={() => go(p, 'paused')}>
                Pause
              </button>
            }
          />
        ))}
        {Array.from({ length: slots }, (_, i) => (
          <div key={i} className="slot">
            open slot
          </div>
        ))}
        <h3>Paused</h3>
        {by('paused').length === 0 && <p className="muted small">Nothing paused.</p>}
        {by('paused').map((p) => (
          <ProjectRow
            key={p.id}
            p={p}
            extra={
              <>
                {stale.has(p.id) && <span className="tag warn">stale 14d+</span>}
                <button className="small" onClick={() => go(p, 'active')}>
                  Resume
                </button>
              </>
            }
          />
        ))}
      </section>

      <section className="panel">
        <header className="panel-head">
          <h2>Layer C: Wild Garden</h2>
        </header>
        <p className="muted small">Curiosities, sketches and tiny experiments. No roadmap required.</p>
        <h3>Experiments</h3>
        {by('experiment').map((p) => (
          <ProjectRow
            key={p.id}
            p={p}
            extra={
              <>
                <span className="muted small">{p.experiment?.timeCapMin}m cap</span>
                <button className="small" onClick={() => go(p, 'cooling')}>
                  Test complete
                </button>
              </>
            }
          />
        ))}
        <h3>Cooling</h3>
        {by('cooling').map((p) => (
          <ProjectRow
            key={p.id}
            p={p}
            extra={
              <>
                <span className="muted small">{Math.floor(hoursCooling(p, now))}h</span>
                <button className="small primary" onClick={() => openFirewall(p.id)}>
                  Firewall
                </button>
              </>
            }
          />
        ))}
        <h3>Incubator</h3>
        {by('incubator').map((p) => (
          <ProjectRow
            key={p.id}
            p={p}
            extra={
              <button className="small" onClick={() => openFirewall(p.id)}>
                Review
              </button>
            }
          />
        ))}
      </section>
      <a className="panel link-row" href="#freezer">
        <span>
          <strong>Freezer</strong>
          <span className="muted small"> · completed and archived work, searchable</span>
        </span>
        <Icon name="chevron" size={18} />
      </a>
      {dialog}
    </div>
  );
}

export function Freezer() {
  const { db } = useStore();
  const [q, setQ] = useState('');
  const needle = q.toLowerCase();
  const items = db.projects
    .filter((p) => p.state === 'archived' || p.state === 'completed')
    .filter((p) =>
      !needle ||
      [p.title, p.why, p.completion, p.card.outcome, p.card.lastThought, ...p.card.files].some((s) => s?.toLowerCase().includes(needle)),
    );
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Freezer</h2>
      </header>
      <p className="muted">Completed and declined work stays searchable, out of the active visual field.</p>
      <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search titles, notes, files…" />
      {items.map((p) => (
        <ProjectRow key={p.id} p={p} extra={<span className="tag">{STATE_LABEL[p.state]}</span>} />
      ))}
    </section>
  );
}
