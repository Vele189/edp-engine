import { useState } from 'react';
import { REASON_LABELS, activeStudio, transition } from '../engine/engine';
import type { Layer, Project, ReasonKind, State } from '../engine/types';
import { useStore } from '../store';
import { AutoText, Modal, Problems, STATE_LABEL } from './ui';

const DEFAULT_REASON: Record<State, ReasonKind> = {
  inbox: 'evidence',
  experiment: 'test',
  cooling: 'evidence',
  incubator: 'capacity',
  active: 'evidence',
  paused: 'capacity',
  completed: 'outcome',
  archived: 'release',
};

export function TransitionDialog({ p, to, onClose }: { p: Project; to: State; onClose: () => void }) {
  const { db, act } = useStore();
  const [reason, setReason] = useState<ReasonKind>(DEFAULT_REASON[to]);
  const [note, setNote] = useState('');
  const [question, setQuestion] = useState('');
  const [cap, setCap] = useState(60);
  const [completion, setCompletion] = useState('');
  const [coexist, setCoexist] = useState('');
  const [layer, setLayer] = useState<Layer>(p.layer === 'garden' ? 'studio' : p.layer);
  const [problems, setProblems] = useState<string[]>([]);

  const needsLayer = to === 'active' && p.layer === 'garden';
  const trioFull = to === 'active' && layer === 'studio' && activeStudio(db).length >= db.settings.activeLimit;

  function submit() {
    const errs = act((d, now) =>
      transition(
        d,
        p.id,
        to,
        {
          reason,
          note,
          experiment: to === 'experiment' ? { question, timeCapMin: cap } : undefined,
          completion,
          coexist,
          layer: needsLayer ? layer : undefined,
        },
        now,
      ),
    );
    setProblems(errs);
    if (!errs.length) onClose();
  }

  return (
    <Modal title={`${STATE_LABEL[p.state]} → ${STATE_LABEL[to]}`} onClose={onClose}>
      <p className="muted">No state change without a reason.</p>
      <label>
        <span>Reason</span>
        <select value={reason} onChange={(e) => setReason(e.target.value as ReasonKind)}>
          {Object.entries(REASON_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>{to === 'paused' ? 'Why pause? (required)' : 'Note'}</span>
        <AutoText singleLine value={note} onChange={(v) => setNote(v)} autoFocus />
      </label>

      {to === 'experiment' && (
        <>
          <label>
            <span>One learning question</span>
            <AutoText singleLine value={question} onChange={(v) => setQuestion(v)} placeholder="Would anyone open this twice?" />
          </label>
          <label>
            <span>Time cap (minutes)</span>
            <input type="number" min={5} step={5} value={cap} onChange={(e) => setCap(Number(e.target.value))} />
          </label>
        </>
      )}

      {needsLayer && (
        <label>
          <span>Assign to</span>
          <select value={layer} onChange={(e) => setLayer(e.target.value as Layer)}>
            <option value="studio">Active Studio</option>
            <option value="anchor">Anchors (obligation)</option>
          </select>
        </label>
      )}

      {trioFull && (
        <label>
          <span>The Active Studio is full. Pause one first (swap), or say why this explicitly coexists:</span>
          <AutoText singleLine value={coexist} onChange={(v) => setCoexist(v)} placeholder="Urgent client deadline; reducing X's scope" />
        </label>
      )}

      {to === 'completed' && (
        <label>
          <span>What shipped, or what was learned?</span>
          <AutoText value={completion} onChange={(v) => setCompletion(v)} />
        </label>
      )}

      <Problems items={problems} />
      <div className="actions">
        <button className="ghost" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" onClick={submit}>
          Move to {STATE_LABEL[to]}
        </button>
      </div>
    </Modal>
  );
}
