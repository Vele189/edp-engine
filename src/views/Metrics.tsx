import { useRef, useState } from 'react';
import {
  MECHANISMS,
  MISS_CAUSES,
  deadlinesIcs,
  pilotWeek,
  setBaseline,
  setMechanism,
  weekStart,
  weeklyMetrics,
  type WeekMetrics,
} from '../engine/engine';
import type { Baseline, MechanismKey, MechanismStatus, MissCause } from '../engine/types';
import { download, exportJson, importJson, useStore } from '../store';
import { AutoText } from '../components/ui';

const pct = (r: { success: number; total: number }) => (r.total ? `${Math.round((100 * r.success) / r.total)}% (${r.total})` : '—');

export function Metrics() {
  const { db } = useStore();
  const thisWeek = weekStart(new Date());
  const weeks = Array.from({ length: 6 }, (_, i) => {
    const s = new Date(thisWeek);
    s.setDate(s.getDate() - 7 * i);
    return weeklyMetrics(db, s);
  });
  const b = db.baseline;

  return (
    <div className="stack">
      <Pilot />
      <section className="panel">
        <header className="panel-head">
          <h2>Measurement</h2>
        </header>
        <p className="muted">
          Success: less restart friction, fewer avoidable misses, stable or better output, low admin burden. Keep measurement
          approximate.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Week of</th>
                <th title="Resumed within ~60s using the card">Re-entry</th>
                <th title="Shipped, tested, solved, published, obligation, or completed">Outputs</th>
                <th title="Recorded during the weekly reset">Misses</th>
                <th title="Engine maintenance, from the weekly reset">Overhead</th>
                <th>Worked</th>
                <th title="Low-dopamine pit stops">Prep</th>
              </tr>
            </thead>
            <tbody>
              {b && (
                <tr className="baseline-row">
                  <td>Week 0</td>
                  <td>~{b.restartDelayMin}m to restart</td>
                  <td>~{b.outputsPerWeek}</td>
                  <td>~{b.missesPerWeek}</td>
                  <td>planning displaces: {b.planningDisplaces}</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              )}
              {weeks.map((w) => (
                <tr key={w.start.toISOString()}>
                  <td>{w.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td>
                  <td>{pct(w.reentry)}</td>
                  <td>{w.outputs}</td>
                  <td>{w.misses}</td>
                  <td>{w.overheadMin === null ? '—' : `${w.overheadMin}m`}</td>
                  <td>{w.minutesWorked ? `${Math.round(w.minutesWorked / 6) / 10}h` : '—'}</td>
                  <td>{w.pitStopMin ? `${Math.round(w.pitStopMin)}m` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Insights weeks={weeks} />
      </section>
      <Experiments />
      <Settings />
      <Evidence />
    </div>
  );
}

/** Aggregates over the visible weeks: miss causes and the body-doubling comparison. */
function Insights({ weeks }: { weeks: WeekMetrics[] }) {
  const causes: Partial<Record<MissCause, number>> = {};
  const bd = { with: { success: 0, total: 0 }, without: { success: 0, total: 0 } };
  for (const w of weeks) {
    for (const [k, n] of Object.entries(w.causes)) causes[k as MissCause] = (causes[k as MissCause] ?? 0) + n;
    for (const side of ['with', 'without'] as const) {
      bd[side].success += w.bodyDouble[side].success;
      bd[side].total += w.bodyDouble[side].total;
    }
  }
  const causeList = Object.entries(causes).sort((a, b) => b[1] - a[1]);
  return (
    <div className="grid2 insights">
      <div>
        <h3>Why misses happened (6 weeks)</h3>
        {causeList.length === 0 ? (
          <p className="muted small">No misses recorded.</p>
        ) : (
          <ul className="plain">
            {causeList.map(([k, n]) => (
              <li key={k}>
                {MISS_CAUSES[k as MissCause]}: <strong>{n}</strong>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3>Re-entry with vs without body doubling</h3>
        {bd.with.total === 0 ? (
          <p className="muted small">No body-doubled sessions with a re-entry answer yet.</p>
        ) : (
          <p className="small">
            With: <strong>{pct(bd.with)}</strong> · Without: <strong>{pct(bd.without)}</strong>
          </p>
        )}
      </div>
    </div>
  );
}

function Pilot() {
  const { db, act } = useStore();
  const now = new Date();
  const week = pilotWeek(db, now);
  const [form, setForm] = useState<Omit<Baseline, 'at'>>(
    db.baseline ?? { restartDelayMin: 20, missesPerWeek: 1, outputsPerWeek: 2, planningDisplaces: 'sometimes' },
  );
  const [editing, setEditing] = useState(!db.baseline);
  const num = (k: 'restartDelayMin' | 'missesPerWeek' | 'outputsPerWeek', label: string) => (
    <label>
      <span>{label}</span>
      <input type="number" min={0} value={form[k]} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />
    </label>
  );

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Baseline &amp; two-week pilot</h2>
        {week === 0 ? (
          <button
            className="primary small"
            disabled={!db.baseline}
            title={db.baseline ? '' : 'Record a baseline first'}
            onClick={() => act((d, n) => ({ ...d, pilotStartedAt: n.toISOString() }))}
          >
            Start pilot
          </button>
        ) : (
          <span className="tag">{week === 3 ? 'pilot complete' : `pilot week ${week}`}</span>
        )}
      </header>
      <p className="muted small">
        Week 1: capture + re-entry cards. Week 2: add the commitment firewall and weekly reset. Change one major variable at a time.
      </p>
      {editing ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act((d, n) => setBaseline(d, form, n));
            setEditing(false);
          }}
        >
          <p className="small">Week 0: rough guesses from a typical recent week.</p>
          <div className="grid2">
            {num('restartDelayMin', 'Typical restart delay on interrupted work (min)')}
            {num('missesPerWeek', 'Missed commitments per week')}
            {num('outputsPerWeek', 'Meaningful outputs per week')}
            <label>
              <span>How often does planning displace execution?</span>
              <select
                value={form.planningDisplaces}
                onChange={(e) => setForm({ ...form, planningDisplaces: e.target.value as Baseline['planningDisplaces'] })}
              >
                <option value="rarely">Rarely</option>
                <option value="sometimes">Sometimes</option>
                <option value="often">Often</option>
              </select>
            </label>
          </div>
          <div className="actions left">
            <button className="primary" type="submit">
              Save baseline
            </button>
          </div>
        </form>
      ) : (
        <button className="ghost small" onClick={() => setEditing(true)}>
          Edit baseline
        </button>
      )}
      {week === 3 && (
        <p className="small">
          Pilot done. Compare against Week 0: keep only mechanisms that measurably helped, and drop the ones that created guilt or admin.
        </p>
      )}
    </section>
  );
}

/** Iteration rule: keep only mechanisms that measurably help; change one variable at a time. */
function Experiments() {
  const { db, act } = useStore();
  const set = (k: MechanismKey, status: MechanismStatus, note: string) => act((d, n) => setMechanism(d, k, status, note, n));
  const trials = Object.values(db.settings.mechanisms).filter((m) => m.status === 'trial').length;
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Mechanisms</h2>
      </header>
      <p className="muted small">
        Every component is a testable hypothesis. Put one on <em>trial</em> at a time, then keep or switch it off. Switched-off
        mechanisms disappear from the app.
      </p>
      {trials > 1 && <p className="notice">{trials} mechanisms on trial at once: change one major variable at a time.</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Mechanism</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(MECHANISMS) as MechanismKey[]).map((k) => {
              const m = db.settings.mechanisms[k];
              return (
                <tr key={k}>
                  <td>
                    <strong>{MECHANISMS[k].label}</strong>
                    <div className="muted small">{MECHANISMS[k].help}</div>
                  </td>
                  <td>
                    <div className="segmented">
                      {(['on', 'trial', 'off'] as const).map((s) => (
                        <button
                          key={s}
                          className={m.status === s ? 'on' : ''}
                          aria-pressed={m.status === s}
                          onClick={() => {
                            if (k === 'notifications' && s !== 'off' && 'Notification' in window) Notification.requestPermission();
                            set(k, s, m.note);
                          }}
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                    {m.status === 'trial' && m.since && <div className="muted small">since {m.since.slice(0, 10)}</div>}
                  </td>
                  <td>
                    <AutoText singleLine value={m.note} placeholder="Did it change behaviour?" onChange={(v) => set(k, m.status, v)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Settings() {
  const { db, act, replace } = useStore();
  const file = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState('');
  const setting = (k: 'activeLimit' | 'coolDownHours', v: number) =>
    act((d) => ({ ...d, settings: { ...d.settings, [k]: Math.max(0, v) } }));

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Settings &amp; data</h2>
      </header>
      <div className="grid2">
        <label>
          <span>Active Studio limit (a default constraint, not a moral law)</span>
          <input type="number" min={1} value={db.settings.activeLimit} onChange={(e) => setting('activeLimit', Number(e.target.value))} />
        </label>
        <label>
          <span>Cool-down before commitment (hours)</span>
          <input type="number" min={0} value={db.settings.coolDownHours} onChange={(e) => setting('coolDownHours', Number(e.target.value))} />
        </label>
      </div>
      <p className="muted small">
        Your data lives only in this browser (IndexedDB). Export regularly as a backup. The calendar file puts deadlines where you
        already look.
      </p>
      <div className="actions left">
        <button onClick={() => exportJson(db)}>Export JSON</button>
        <button onClick={() => file.current?.click()}>Import JSON</button>
        <button onClick={() => download('edp-deadlines.ics', deadlinesIcs(db, new Date()), 'text/calendar')}>
          Deadlines → calendar (.ics)
        </button>
        <input
          ref={file}
          type="file"
          accept="application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            try {
              const data = await importJson(f);
              if (confirm(`Replace all current data with ${data.projects.length} projects from ${f.name}?`)) {
                replace(data);
                setMsg('Imported.');
              }
            } catch (err) {
              setMsg((err as Error).message);
            }
            e.target.value = '';
          }}
        />
        {msg && <span className="muted">{msg}</span>}
      </div>
    </section>
  );
}

function Evidence() {
  return (
    <section className="panel">
      <details>
        <summary>
          <strong>Evidence &amp; limits</strong>
        </summary>
        <p className="small">
          The cited literature concerns ADHD and executive function broadly; it does not validate this exact personal workflow. Treat
          every component as a testable hypothesis. This is a practical design hypothesis, not a clinical treatment.
        </p>
        <ul className="small">
          <li>
            Ramos-Galarza et al. (2024). Systematic Review of Executive Function Stimulation Methods in the ADHD Population.{' '}
            <em>Journal of Clinical Medicine</em> 13(14), 4208.{' '}
            <a href="https://pmc.ncbi.nlm.nih.gov/articles/PMC11278469/" target="_blank" rel="noreferrer">
              PMC11278469
            </a>
          </li>
          <li>
            Lauder, McDowall &amp; Tenenbaum (2024). Meta-analysis of pharmacological and psychosocial interventions for
            work-relevant outcomes in adults with ADHD.{' '}
            <a href="https://doi.org/10.1177/27546330241292984" target="_blank" rel="noreferrer">
              doi:10.1177/27546330241292984
            </a>
          </li>
        </ul>
        <p className="small muted">Research practice: separate evidence from interpretation, and update the model when personal experiments contradict assumptions.</p>
      </details>
    </section>
  );
}
