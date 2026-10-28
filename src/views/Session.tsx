import { useEffect, useRef, useState } from 'react';
import {
  closeSession,
  endPitStop,
  getProject,
  markResume,
  mechanismOn,
  startSession,
  type CloseInput,
} from '../engine/engine';
import type { OutputKind, PitStop, Session } from '../engine/types';
import { useStore } from '../store';
import { AutoText, Beacon, FileLink, NextActionFields, Problems } from '../components/ui';

const OUTPUT_KINDS: [OutputKind | 'none', string][] = [
  ['none', 'No tangible output (that’s okay)'],
  ['shipped', 'Shipped artifact'],
  ['tested', 'Tested hypothesis'],
  ['solved', 'Solved issue'],
  ['published', 'Published / finished draft'],
  ['obligation', 'Completed obligation'],
];

function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}

/** External cue: one notification when the time box ends; nothing else, to avoid noise. */
function useStoppingCue(over: boolean, title: string, enabled: boolean) {
  const fired = useRef(false);
  useEffect(() => {
    if (!over || fired.current || !enabled) return;
    fired.current = true;
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification('Stopping cue', { body: `${title}: write what changed and the next physical action.` });
    }
  }, [over, title, enabled]);
}

const mmss = (sec: number) => `${Math.floor(Math.abs(sec) / 60)}:${String(Math.floor(Math.abs(sec) % 60)).padStart(2, '0')}`;

export function SessionRunner({ s }: { s: Session }) {
  const { db, act } = useStore();
  const p = getProject(db, s.projectId);
  const [closing, setClosing] = useState(false);
  useTick(1000);

  const elapsed = (Date.now() - new Date(s.startedAt).getTime()) / 1000;
  const left = s.plannedMin * 60 - elapsed;
  const over = left <= 0;
  const overrunMin = -left / 60;
  useStoppingCue(over, p.title, mechanismOn(db, 'notifications'));

  useEffect(() => {
    document.title = over ? '⏰ Stopping cue — EDP Engine' : `${mmss(left)} · ${p.title}`;
    return () => {
      document.title = 'EDP Engine';
    };
  });

  return (
    <div className="session">
      <header className="session-head">
        <div>
          <p className="eyebrow">
            Session · {s.capacity} capacity{s.bodyDouble ? ' · body doubling' : ''}
          </p>
          <h2>{p.title}</h2>
        </div>
        <div className={`timer ${over ? 'over' : ''}`}>
          {over ? '+' : ''}
          {mmss(left)}
        </div>
      </header>

      {over && !closing && (
        <p className="notice">Time box finished. Stopping cue: spend two minutes writing what changed and the next physical action.</p>
      )}
      {overrunMin >= 15 && mechanismOn(db, 'hyperfocusGuard') && !closing && (
        <p className="notice">
          {Math.floor(overrunMin)} minutes past the time box. Hyperfocus check: water, food, movement, and obligations? Don’t romanticize
          exhaustion.
        </p>
      )}

      {!closing && (
        <>
          <p className="muted">Resume contract: read only this card and the linked files. Do not re-plan the whole project.</p>
          <div className="reentry">
            <Beacon next={p.card.next} big />
            <dl>
              <dt>Outcome</dt>
              <dd>{p.card.outcome || '—'}</dd>
              <dt>Current state</dt>
              <dd>{p.card.currentState || '—'}</dd>
              {p.card.lastThought && (
                <>
                  <dt>Last thought</dt>
                  <dd>{p.card.lastThought}</dd>
                </>
              )}
              {p.card.blocker && (
                <>
                  <dt>Blocker</dt>
                  <dd>{p.card.blocker}</dd>
                </>
              )}
              {p.card.files.length > 0 && (
                <>
                  <dt>Files</dt>
                  <dd>
                    {p.card.files.map((f) => (
                      <FileLink key={f} path={f} />
                    ))}
                  </dd>
                </>
              )}
            </dl>
          </div>

          {s.resumedQuickly === undefined && (
            <div className="resume-check">
              <span>Could you start real work within about 60 seconds using this card?</span>
              <button onClick={() => act((d) => markResume(d, s.id, true))}>Yes</button>
              <button onClick={() => act((d) => markResume(d, s.id, false))}>No</button>
            </div>
          )}

          <div className="actions">
            <button className="primary" onClick={() => setClosing(true)}>
              Stop &amp; leave a beacon
            </button>
          </div>
        </>
      )}

      {closing && <CloseForm s={s} onCancel={() => setClosing(false)} />}
    </div>
  );
}

function CloseForm({ s, onCancel }: { s: Session; onCancel: () => void }) {
  const { db, act } = useStore();
  const p = getProject(db, s.projectId);
  const [form, setForm] = useState<CloseInput>({
    output: '',
    outputKind: 'none',
    blocker: p.card.blocker,
    next: p.card.next,
    file: '',
    lastThought: '',
    decision: 'rotate',
    pauseReason: '',
  });
  const [problems, setProblems] = useState<string[]>([]);
  const set = (f: Partial<CloseInput>) => setForm({ ...form, ...f });

  function submit() {
    const errs = act((d, now) => {
      const closed = closeSession(d, s.id, form, now);
      return form.decision === 'continue' ? startSession(closed, s.projectId, s.capacity, s.plannedMin, now, s.bodyDouble) : closed;
    });
    setProblems(errs);
  }

  return (
    <div className="close-form">
      <h3>Session close: two minutes</h3>
      <label>
        <span>What changed?</span>
        <AutoText value={form.output} onChange={(v) => set({ output: v })} autoFocus />
      </label>
      <label>
        <span>Output type</span>
        <select value={form.outputKind} onChange={(e) => set({ outputKind: e.target.value as CloseInput['outputKind'] })}>
          {OUTPUT_KINDS.map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Blocker</span>
        <AutoText singleLine value={form.blocker} onChange={(v) => set({ blocker: v })} />
      </label>
      <NextActionFields value={form.next} onChange={(next) => set({ next })} />
      <label>
        <span>File link (optional)</span>
        <input value={form.file} onChange={(e) => set({ file: e.target.value })} placeholder="Exact file to open next time" />
      </label>
      <label>
        <span>Last thought</span>
        <AutoText singleLine value={form.lastThought} onChange={(v) => set({ lastThought: v })} />
      </label>
      <div className="segmented wide" role="radiogroup">
        {(['continue', 'rotate', 'pause'] as const).map((d) => (
          <button key={d} type="button" className={form.decision === d ? 'on' : ''} aria-pressed={form.decision === d} onClick={() => set({ decision: d })}>
            {d}
          </button>
        ))}
      </div>
      {form.decision === 'pause' && (
        <label>
          <span>Why pause?</span>
          <AutoText singleLine value={form.pauseReason ?? ''} onChange={(v) => set({ pauseReason: v })} />
        </label>
      )}
      <Problems items={problems} />
      <div className="actions">
        <button className="ghost" onClick={onCancel}>
          Back
        </button>
        <button className="primary" onClick={submit}>
          Close session
        </button>
      </div>
    </div>
  );
}

export function PitStopRunner({ stop }: { stop: PitStop }) {
  const { db, act } = useStore();
  useTick(1000);
  const left = stop.plannedMin * 60 - (Date.now() - new Date(stop.startedAt).getTime()) / 1000;
  useStoppingCue(left <= 0, 'Pit stop', mechanismOn(db, 'notifications'));
  return (
    <div className="session">
      <header className="session-head">
        <div>
          <p className="eyebrow">Low-dopamine pit stop</p>
          <h2>{stop.what}</h2>
        </div>
        <div className={`timer ${left <= 0 ? 'over' : ''}`}>
          {left <= 0 ? '+' : ''}
          {mmss(left)}
        </div>
      </header>
      <p className="muted">
        {left <= 0
          ? 'Limit reached. Preparation can quietly become avoidance. Wrap up and go do the real thing.'
          : 'Preparation is useful, but it is not progress. Stop when the timer ends.'}
      </p>
      <div className="actions">
        <button className="primary" onClick={() => act((d, n) => endPitStop(d, n))}>
          Done
        </button>
      </div>
    </div>
  );
}
