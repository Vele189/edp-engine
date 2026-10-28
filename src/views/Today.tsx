import { useState } from 'react';
import {
  daysUntil,
  failureSignals,
  mechanismOn,
  openPitStop,
  openSession,
  pilotWeek,
  randomPick,
  route,
  setDailyOpen,
  startPitStop,
  startSession,
  todaysOpen,
} from '../engine/engine';
import type { Capacity, Project } from '../engine/types';
import { useStore } from '../store';
import { AutoText, Beacon, CapacityPicker, FileLink, Modal, Problems, ProjectRow, useUi } from '../components/ui';
import { Icon } from '../components/icons';
import { PitStopRunner, SessionRunner } from './Session';

const CAPACITY_HINT: Record<Capacity, string> = {
  low: 'Choose a 5–15 minute re-entry action: simple asset prep, reference gathering, or essential admin. Preparation is not progress.',
  medium: 'Choose a defined task with visible output: one design iteration, one bug, one section draft, one small research synthesis.',
  high: 'Use for cognitively demanding work, but first check deadlines, meals, sleep and stopping boundaries. Hyperfocus is capacity, not an unlimited resource.',
};

const PILOT_FOCUS = {
  1: 'Week 1: use capture and re-entry cards. Leave a beacon every time you stop.',
  2: 'Week 2: add the commitment firewall and the weekly reset.',
};

export function Today() {
  const { db, act } = useStore();
  const now = new Date();
  const running = openSession(db);
  const pit = openPitStop(db);
  const [capacity, setCapacity] = useState<Capacity>('medium');
  const [minutes, setMinutes] = useState(30);
  const [recovery, setRecovery] = useState(false);
  const [bodyDouble, setBodyDouble] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [guarding, setGuarding] = useState<{ p: Project; min: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  if (running) return <SessionRunner s={running} />;
  if (pit) return <PitStopRunner stop={pit} />;

  const effective = recovery ? 'low' : capacity;
  const { urgent, options } = route(db, effective, now);
  const signals = mechanismOn(db, 'failureSignals') ? failureSignals(db, now) : [];
  const doubling = mechanismOn(db, 'bodyDoubling') && bodyDouble;

  const begin = (p: Project, min: number) =>
    setProblems(act((d, n) => startSession(d, p.id, effective, min, n, doubling)));
  const start = (p: Project, min = recovery ? 15 : minutes) => {
    if (effective === 'high' && mechanismOn(db, 'hyperfocusGuard')) setGuarding({ p, min });
    else begin(p, min);
  };
  const startBtn = (p: Project) => (
    <button className="primary small" onClick={() => start(p)}>
      Start
    </button>
  );
  const week = pilotWeek(db, now);

  return (
    <div className="stack">
      {(week === 1 || week === 2) && <p className="pilot">Pilot · {PILOT_FOCUS[week]}</p>}
      {week === 0 && !db.baseline && db.projects.length === 0 && (
        <p className="pilot">
          New here? Record a rough <a href="#metrics">Week-0 baseline</a> first, then start the two-week pilot.
        </p>
      )}

      <DailyOpen />

      {signals.length > 0 && (
        <div className="notice">
          <strong>Failure signals</strong>
          <ul>
            {signals.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      {mechanismOn(db, 'playground') && <Playground />}

      <section className="panel">
        <header className="panel-head">
          <h2>Attention router</h2>
          <label className="inline toggle">
            <input type="checkbox" role="switch" checked={recovery} onChange={(e) => setRecovery(e.target.checked)} />
            <span>Recovery mode</span>
          </label>
        </header>

        {recovery ? (
          <p className="muted">
            The day collapsed. Protect urgent obligations, choose one minimum viable action, and reset without trying to repay every
            missed task.
          </p>
        ) : (
          <>
            <div className="router-controls">
              <div>
                <span className="label">Capacity right now</span>
                <CapacityPicker value={capacity} onChange={setCapacity} />
              </div>
              <div>
                <span className="label">Time box</span>
                <div className="segmented">
                  {[15, 30, 60].map((m) => (
                    <button key={m} className={minutes === m ? 'on' : ''} aria-pressed={minutes === m} onClick={() => setMinutes(m)}>
                      {m}m
                    </button>
                  ))}
                </div>
              </div>
              {mechanismOn(db, 'bodyDoubling') && (
                <label className="inline toggle">
                  <input type="checkbox" role="switch" checked={bodyDouble} onChange={(e) => setBodyDouble(e.target.checked)} />
                  <span>Body doubling (with someone / co-working)</span>
                </label>
              )}
            </div>
            <p className="muted">{CAPACITY_HINT[capacity]}</p>
          </>
        )}

        {urgent.length > 0 && (
          <>
            <h3>Protect first</h3>
            {urgent.map((p) => (
              <ProjectRow
                key={p.id}
                p={p}
                extra={
                  <>
                    <span className="tag warn">
                      {daysUntil(p.deadline!, now) < 0 ? 'overdue' : `${daysUntil(p.deadline!, now)}d left`}
                    </span>
                    {startBtn(p)}
                  </>
                }
              />
            ))}
          </>
        )}

        <h3>Fits {effective} capacity</h3>
        {options.length === 0 && <p className="muted">Nothing active fits. Lower the capacity, or set next actions on active work.</p>}
        {options.map((p) => (
          <ProjectRow key={p.id} p={p} extra={startBtn(p)} />
        ))}

        {mechanismOn(db, 'randomizer') && options.length >= 2 && (
          <div className="randomizer">
            <button onClick={() => setPicked(randomPick(options)!.id)}>Can’t choose? Randomize 15 minutes</button>
            {picked &&
              (() => {
                const p = options.find((o) => o.id === picked);
                return p ? (
                  <span>
                    → <strong>{p.title}</strong>{' '}
                    <button className="primary small" onClick={() => start(p, 15)}>
                      Go
                    </button>
                  </span>
                ) : null;
              })()}
          </div>
        )}
        <Problems items={problems} />
        <p className="muted small">15-minute start: open the exact file → read the re-entry card → do one small action → decide whether to continue.</p>
      </section>

      {mechanismOn(db, 'pitStop') && <PitStopStarter />}

      <a className="panel link-row" href="#metrics">
        <span>
          <strong>Metrics</strong>
          <span className="muted small"> · baseline, pilot, mechanisms</span>
        </span>
        <Icon name="chevron" size={18} />
      </a>
      <a className="panel link-row" href="#reset">
        <span>
          <strong>Weekly reset</strong>
          <span className="muted small"> · deadlines, trio, stale work, inbox, cards</span>
        </span>
        <Icon name="chevron" size={18} />
      </a>

      {guarding && (
        <HighCapacityCheck
          onCancel={() => setGuarding(null)}
          onGo={() => {
            begin(guarding.p, guarding.min);
            setGuarding(null);
          }}
        />
      )}
    </div>
  );
}

const NEEDS = [
  'Deadlines and anchors are checked',
  'I have eaten and have water nearby',
  'I slept enough to do this well',
  'I know when I will stop',
];

/** Hyperfocus guard: deep absorption can displace rest and obligations. */
function HighCapacityCheck({ onGo, onCancel }: { onGo: () => void; onCancel: () => void }) {
  const [checked, setChecked] = useState<boolean[]>(NEEDS.map(() => false));
  return (
    <Modal title="Before deep work" onClose={onCancel}>
      <p className="muted">Hyperfocus is capacity, not an unlimited resource.</p>
      {NEEDS.map((n, i) => (
        <label key={n} className="inline check">
          <input type="checkbox" checked={checked[i]} onChange={() => setChecked(checked.map((c, j) => (j === i ? !c : c)))} />
          <span>{n}</span>
        </label>
      ))}
      <div className="actions">
        <button className="ghost" onClick={onGo}>
          Start anyway
        </button>
        <button className="primary" disabled={!checked.every(Boolean)} onClick={onGo}>
          Start deep work
        </button>
      </div>
    </Modal>
  );
}

/** Playground: one visible place with shortcuts to current work, not copies of every asset. */
function Playground() {
  const { db } = useStore();
  const { openProject } = useUi();
  const active = db.projects
    .filter((p) => p.state === 'active')
    .sort((a, b) => (a.layer === 'anchor' ? 0 : 1) - (b.layer === 'anchor' ? 0 : 1));
  if (!active.length) return null;
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Playground</h2>
      </header>
      <div className="playground">
        {active.map((p) => (
          <div key={p.id} className="shortcut">
            <button className="link" onClick={() => openProject(p.id)}>
              {p.title}
            </button>
            <Beacon next={p.card.next} />
            {p.card.files.slice(0, 2).map((f) => (
              <FileLink key={f} path={f} />
            ))}
            {p.card.files.length === 0 && <div className="muted small">No file linked yet</div>}
          </div>
        ))}
      </div>
    </section>
  );
}

function PitStopStarter() {
  const { act } = useStore();
  const [what, setWhat] = useState('');
  const [min, setMin] = useState(10);
  const [problems, setProblems] = useState<string[]>([]);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Low-dopamine pit stop</h2>
      </header>
      <p className="muted small">Charge equipment, gather references, prepare the workspace, small maintenance. Capped so it doesn’t become avoidance.</p>
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          setProblems(act((d, n) => startPitStop(d, what, min, n)));
        }}
      >
        <input value={what} onChange={(e) => setWhat(e.target.value)} placeholder="What preparation?" />
        <div className="segmented">
          {[5, 10, 15].map((m) => (
            <button key={m} type="button" className={min === m ? 'on' : ''} aria-pressed={min === m} onClick={() => setMin(m)}>
              {m}m
            </button>
          ))}
        </div>
        <button type="submit">Start</button>
      </form>
      <Problems items={problems} />
    </section>
  );
}

function DailyOpen() {
  const { db, act } = useStore();
  const now = new Date();
  const today = todaysOpen(db, now);
  const [intent, setIntent] = useState('');
  const [projectId, setProjectId] = useState('');
  const [editing, setEditing] = useState(false);
  const anchors = db.projects
    .filter((p) => p.layer === 'anchor' && p.state === 'active')
    .sort((a, b) => (a.deadline ?? '9999').localeCompare(b.deadline ?? '9999'));
  const active = db.projects.filter((p) => p.state === 'active');

  if (today && !editing) {
    const p = db.projects.find((x) => x.id === today.projectId);
    return (
      <section className="panel today-intent">
        <p className="eyebrow">Today’s one meaningful output</p>
        <h2>{today.intent}</h2>
        {p && (
          <p className="muted">
            {p.title}: {p.card.files[0] ? <FileLink path={p.card.files[0]} /> : <Beacon next={p.card.next} />}
          </p>
        )}
        <button className="ghost small" onClick={() => setEditing(true)}>
          change
        </button>
      </section>
    );
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Daily open: 3 min</h2>
      </header>
      <h3>Anchors and deadlines</h3>
      {anchors.length === 0 && <p className="muted">No active anchors.</p>}
      {anchors.map((p) => (
        <ProjectRow key={p.id} p={p} />
      ))}
      <form
        className="stack-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (!intent.trim()) return;
          act((d, n) => setDailyOpen(d, intent, projectId || undefined, n));
          setEditing(false);
        }}
      >
        <label>
          <span>Pick one meaningful output for today</span>
          <AutoText singleLine value={intent} onChange={(v) => setIntent(v)} placeholder="Finish the poster headline layout" />
        </label>
        <label>
          <span>For</span>
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">(none)</option>
            {active.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">Then open the exact file before browsing the wider workspace.</p>
        <div className="actions">
          <button className="primary" type="submit">
            Open the day
          </button>
        </div>
      </form>
    </section>
  );
}
