import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { isNextComplete } from '../engine/engine';
import type { Capacity, Layer, NextAction, Project, State } from '../engine/types';

interface Ui {
  openProject: (id: string) => void;
  openFirewall: (id: string) => void;
}

export const UiCtx = createContext<Ui | null>(null);
export const useUi = () => useContext(UiCtx)!;

export const LAYER_LABEL: Record<Layer, string> = { anchor: 'Anchor', studio: 'Studio', garden: 'Garden' };
export const STATE_LABEL: Record<State, string> = {
  inbox: 'Inbox',
  experiment: 'Experiment',
  cooling: 'Cooling',
  incubator: 'Incubator',
  active: 'Active',
  paused: 'Paused',
  completed: 'Completed',
  archived: 'Archived',
};

export function Problems({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="problems" role="alert">
      {items.map((p) => (
        <li key={p}>{p}</li>
      ))}
    </ul>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only the topmost dialog reacts to Escape.
    const onKey = (e: KeyboardEvent) => {
      const overlays = document.querySelectorAll('.overlay');
      if (e.key === 'Escape' && overlays[overlays.length - 1] === ref.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div ref={ref} className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <span className="grabber" aria-hidden="true" />
        <header className="modal-head">
          <h2>{title}</h2>
          <button className="plain done" onClick={onClose}>
            Done
          </button>
        </header>
        {children}
      </div>
    </div>
  );
}

/**
 * A text field that wraps and grows to fit its content, so long titles and notes are never
 * scrolled sideways inside a small box. `singleLine` keeps title-like fields to one paragraph.
 */
export function AutoText({
  value,
  onChange,
  singleLine = false,
  className = '',
  onKeyDown,
  ...rest
}: { value: string; onChange: (v: string) => void; singleLine?: boolean } & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
  };
  useLayoutEffect(fit, [value]);
  useEffect(() => {
    // Wrapping changes with width, so refit when the field is resized.
    const ro = new ResizeObserver(fit);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      className={`auto ${className}`}
      value={value}
      onChange={(e) => onChange(singleLine ? e.target.value.replace(/\n/g, ' ') : e.target.value)}
      onKeyDown={(e) => {
        // One-line fields keep input behaviour: Enter submits the surrounding form instead of adding a line.
        if (singleLine && e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.form?.requestSubmit();
        }
        onKeyDown?.(e);
      }}
      {...rest}
    />
  );
}

export function CapacityPicker({ value, onChange }: { value: Capacity; onChange: (c: Capacity) => void }) {
  return (
    <div className="segmented">
      {(['low', 'medium', 'high'] as const).map((c) => (
        <button key={c} className={value === c ? 'on' : ''} aria-pressed={value === c} onClick={() => onChange(c)} type="button">
          {c}
        </button>
      ))}
    </div>
  );
}

export function NextActionFields({ value, onChange }: { value: NextAction; onChange: (n: NextAction) => void }) {
  const field = (k: 'verb' | 'object' | 'location' | 'done', label: string, ph: string) => (
    <label>
      <span>{label}</span>
      <AutoText singleLine value={value[k]} placeholder={ph} onChange={(v) => onChange({ ...value, [k]: v })} />
    </label>
  );
  return (
    <fieldset className="beacon">
      <legend>NEXT physical action</legend>
      <div className="grid-next">
        {field('verb', 'Verb', 'Open')}
        {field('object', 'Specific object', 'the poster file')}
        {field('location', 'Location', 'Figma / ~/work/poster')}
        {field('done', 'Done when', 'headline sits above portrait')}
      </div>
      <label className="inline">
        <span>Capacity needed</span>
        <CapacityPicker value={value.energy} onChange={(energy) => onChange({ ...value, energy })} />
      </label>
    </fieldset>
  );
}

/**
 * The signature element: the pause beacon as one sentence — verb + object + location,
 * with the done condition set apart. Spans only, so it can sit inside a button.
 */
export function Beacon({ next, big = false }: { next: NextAction; big?: boolean }) {
  if (!isNextComplete(next)) {
    return <span className="beacon-line empty">No next physical action yet</span>;
  }
  return (
    <span className={`beacon-line${big ? ' big' : ''}`}>
      <span className="beacon-what">
        <span className="beacon-label">Next</span> <strong>{next.verb}</strong> {next.object}{' '}
        <span className="beacon-loc">in {next.location}</span>
      </span>
      <span className="beacon-done">✓ Done when {next.done}</span>
    </span>
  );
}

export function ProjectRow({ p, extra }: { p: Project; extra?: ReactNode }) {
  const { openProject } = useUi();
  return (
    <div className="row">
      <button className="row-main" onClick={() => openProject(p.id)}>
        <span className="row-title">
          {p.title}
          {p.deadline && <span className="tag">due {p.deadline}</span>}
          {p.coexist && <span className="tag warn">coexisting</span>}
        </span>
        {p.state === 'active' || p.state === 'paused' ? (
          <Beacon next={p.card.next} />
        ) : (
          <span className="row-sub">{p.why || STATE_LABEL[p.state]}</span>
        )}
      </button>
      {extra && <div className="row-actions">{extra}</div>}
    </div>
  );
}

/** URLs open directly; local paths can be copied (browsers can't open file:// from a page). */
export function FileLink({ path }: { path: string }) {
  const [copied, setCopied] = useState(false);
  if (/^https?:\/\//.test(path)) {
    return (
      <a className="file" href={path} target="_blank" rel="noreferrer">
        {path.replace(/^https?:\/\//, '')}
      </a>
    );
  }
  return (
    <span className="file">
      <code>{path}</code>
      <button
        className="ghost small"
        onClick={() =>
          navigator.clipboard.writeText(path).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          })
        }
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </span>
  );
}

export function ago(iso: string, now = new Date()): string {
  const m = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (m < 60) return `${m}m ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}
