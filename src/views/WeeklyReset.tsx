import { useState } from 'react';
import { MISS_CAUSES, activeStudio, isNextComplete, saveWeeklyReview, stalePaused } from '../engine/engine';
import type { Miss, MissCause, Project } from '../engine/types';
import { useStore } from '../store';
import { TransitionDialog } from '../components/TransitionDialog';
import { AutoText, ProjectRow, useUi } from '../components/ui';
import { Inbox } from './Lists';

const STEPS = ['Deadlines', 'Active trio', 'Stale work', 'Inbox', 'Re-entry cards', 'Close'];

export function WeeklyReset({ onDone }: { onDone: () => void }) {
  const { db, act } = useStore();
  const { openFirewall } = useUi();
  const now = new Date();
  const [step, setStep] = useState(0);
  const blankMiss = (): Miss => ({ what: '', cause: 'scope', note: '' });
  const [misses, setMisses] = useState<Miss[]>([blankMiss()]);
  const [overhead, setOverhead] = useState(15);
  const [note, setNote] = useState('');
  const [pausing, setPausing] = useState<Project | null>(null);
  const [archiving, setArchiving] = useState<Project | null>(null);

  const anchors = db.projects.filter((p) => p.layer === 'anchor' && p.state === 'active');
  const studio = activeStudio(db);
  const stale = [...stalePaused(db, now), ...db.projects.filter((p) => p.state === 'experiment')];
  const incubator = db.projects.filter((p) => p.state === 'incubator');
  const setMiss = (i: number, m: Partial<Miss>) => setMisses(misses.map((x, j) => (j === i ? { ...x, ...m } : x)));
  const needCards = db.projects.filter(
    (p) => (p.state === 'active' || p.state === 'paused') && (!isNextComplete(p.card.next) || !p.card.outcome.trim()),
  );

  return (
    <div className="stack">
      <nav className="steps">
        {STEPS.map((s, i) => (
          <button key={s} className={i === step ? 'on' : i < step ? 'done' : ''} aria-current={i === step ? 'step' : undefined} onClick={() => setStep(i)}>
            {i + 1}. {s}
          </button>
        ))}
      </nav>

      <section className="panel">
        {step === 0 && (
          <>
            <h2>Review deadlines</h2>
            {anchors.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
            <h3>Misses this week</h3>
            <p className="muted small">
              A missed task is information about scope, cues, capacity or friction. Review the system before concluding motivation is
              the only variable.
            </p>
            {misses.map((m, i) => (
              <div className="grid3" key={i}>
                <AutoText singleLine placeholder="What was missed" value={m.what} onChange={(v) => setMiss(i, { what: v })} />
                <select value={m.cause} onChange={(e) => setMiss(i, { cause: e.target.value as MissCause })}>
                  {Object.entries(MISS_CAUSES).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
                <AutoText singleLine placeholder="What would change it?" value={m.note} onChange={(v) => setMiss(i, { note: v })} />
              </div>
            ))}
            <button className="small ghost" onClick={() => setMisses([...misses, blankMiss()])}>
              + another
            </button>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Choose the active trio</h2>
            <p className="muted">
              {studio.length}/{db.settings.activeLimit} in the studio. Is each one still the right thing for next week?
            </p>
            {studio.map((p) => (
              <ProjectRow
                key={p.id}
                p={p}
                extra={
                  <button className="small" onClick={() => setPausing(p)}>
                    Pause
                  </button>
                }
              />
            ))}
          </>
        )}

        {step === 2 && (
          <>
            <h2>Pause or archive stale work</h2>
            {stale.length === 0 && <p className="muted">Nothing stale.</p>}
            {stale.map((p) => (
              <ProjectRow
                key={p.id}
                p={p}
                extra={
                  <button className="small ghost" onClick={() => setArchiving(p)}>
                    Archive
                  </button>
                }
              />
            ))}
            <h3>Incubator glance</h3>
            <p className="muted small">Look, don’t force it: an idea can stay here without being promoted or killed.</p>
            {incubator.length === 0 && <p className="muted small">Empty.</p>}
            {incubator.map((p) => (
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
          </>
        )}

        {step === 3 && <Inbox />}

        {step === 4 && (
          <>
            <h2>Prepare re-entry cards</h2>
            {needCards.length === 0 ? (
              <p className="muted">Every active and paused project has an outcome and a beacon.</p>
            ) : (
              <p className="muted">These are missing an outcome or a complete next action. Click to fill them in.</p>
            )}
            {needCards.map((p) => (
              <ProjectRow key={p.id} p={p} />
            ))}
          </>
        )}

        {step === 5 && (
          <>
            <h2>Close the reset</h2>
            <label>
              <span>Roughly how many minutes did maintaining the engine cost this week?</span>
              <input type="number" min={0} value={overhead} onChange={(e) => setOverhead(Number(e.target.value))} />
            </label>
            <label>
              <span>Note (what helped, what to drop?)</span>
              <AutoText value={note} onChange={(v) => setNote(v)} />
            </label>
            <p className="muted small">Iteration rule: keep only mechanisms that measurably help.</p>
          </>
        )}

        <div className="actions">
          {step > 0 && (
            <button className="ghost" onClick={() => setStep(step - 1)}>
              Back
            </button>
          )}
          {step < STEPS.length - 1 ? (
            <button className="primary" onClick={() => setStep(step + 1)}>
              Next
            </button>
          ) : (
            <button
              className="primary"
              onClick={() => {
                act((d, n) => saveWeeklyReview(d, overhead, misses, note, n));
                onDone();
              }}
            >
              Save weekly reset
            </button>
          )}
        </div>
      </section>
      {pausing && <TransitionDialog p={pausing} to="paused" onClose={() => setPausing(null)} />}
      {archiving && <TransitionDialog p={archiving} to="archived" onClose={() => setArchiving(null)} />}
    </div>
  );
}
