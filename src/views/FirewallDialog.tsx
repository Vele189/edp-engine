import { useState } from 'react';
import { activeStudio, getProject, hoursCooling, mechanismOn, runFirewall, updateProject } from '../engine/engine';
import type { FirewallReview, Layer, ReentryCard } from '../engine/types';
import { useStore } from '../store';
import { AutoText, Modal, NextActionFields, Problems } from '../components/ui';

const GATES = [
  ['reality', 'Gate 1 — Reality', 'What existing obligation will lose time if this enters? If nothing, is the capacity estimate realistic?'],
  ['evidence', 'Gate 2 — Evidence', 'What smallest observable result would make this more credible? A prototype, user reaction, finished artifact, tested assumption.'],
  ['cost', 'Gate 3 — Cost', 'Opportunity cost in time, money, maintenance and attention? Branding and tooling are costs too.'],
  ['exit', 'Gate 4 — Exit', 'What signal means pause, shrink scope, or stop? Decide before sunk-cost attachment grows.'],
] as const;

export function FirewallDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { db, act } = useStore();
  const p = getProject(db, id);
  const [gates, setGates] = useState(() => ({
    reality: p.firewall?.reality ?? '',
    evidence: p.firewall?.evidence ?? '',
    cost: p.firewall?.cost ?? '',
    exit: p.firewall?.exit ?? '',
  }));
  const [layer, setLayer] = useState<Layer>(p.layer === 'anchor' ? 'anchor' : 'studio');
  const [coexist, setCoexist] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  const now = new Date();
  const cooled = hoursCooling(p, now);
  const tooFresh = mechanismOn(db, 'coolDown') && p.state === 'cooling' && cooled < db.settings.coolDownHours;
  const studio = activeStudio(db);
  const trioFull = layer === 'studio' && studio.length >= db.settings.activeLimit;

  const setCard = (c: Partial<ReentryCard>) =>
    act((d, n) => updateProject(d, id, { card: { ...getProject(d, id).card, ...c } }, n));

  function decide(decision: FirewallReview['decision']) {
    const errs = act((d, n) => runFirewall(d, id, gates, decision, { layer, coexist }, n));
    setProblems(errs);
    if (!errs.length) onClose();
  }

  return (
    <Modal title={`Commitment Firewall: ${p.title}`} onClose={onClose}>
      {tooFresh && (
        <p className="notice">
          Cooling for {Math.floor(cooled)}h of {db.settings.coolDownHours}h. Consider letting it cool before committing.
        </p>
      )}
      {GATES.map(([k, title, prompt]) => (
        <label key={k}>
          <span>
            <strong>{title}</strong> {prompt}
          </span>
          <AutoText value={gates[k]} onChange={(v) => setGates({ ...gates, [k]: v })} />
        </label>
      ))}

      <fieldset className="card-section">
        <legend>Promote only with a clear outcome, capacity, a next action, and a reason it outranks alternatives</legend>
        <label>
          <span>Desired outcome</span>
          <AutoText singleLine value={p.card.outcome} onChange={(v) => setCard({ outcome: v })} />
        </label>
        <NextActionFields value={p.card.next} onChange={(next) => setCard({ next })} />
        <label>
          <span>Assign to</span>
          <select value={layer} onChange={(e) => setLayer(e.target.value as Layer)}>
            <option value="studio">
              Active Studio ({studio.length}/{db.settings.activeLimit})
            </option>
            <option value="anchor">Anchors (obligation)</option>
          </select>
        </label>
        {trioFull && (
          <>
            <p className="notice">
              The studio is full ({studio.map((s) => s.title).join(', ')}). Pause one of those first to swap, or write why this
              explicitly coexists.
            </p>
            <label>
              <span>Coexistence justification</span>
              <AutoText singleLine value={coexist} onChange={(v) => setCoexist(v)} />
            </label>
          </>
        )}
      </fieldset>

      <Problems items={problems} />
      <div className="actions">
        <button onClick={() => decide('decline')} title="Archive it: a decision, not a failure">
          Decline
        </button>
        <button onClick={() => decide('defer')} title="Keep in the incubator: interesting, but capacity or evidence is short">
          Defer
        </button>
        <button className="primary" onClick={() => decide('promote')}>
          Promote
        </button>
      </div>
    </Modal>
  );
}
