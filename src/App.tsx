import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { capture, openSession } from './engine/engine';
import { useStore } from './store';
import { AutoText, Modal, UiCtx } from './components/ui';
import { Icon } from './components/icons';
import { Today } from './views/Today';
import { Freezer, Inbox, Studio } from './views/Lists';
import { WeeklyReset } from './views/WeeklyReset';
import { Metrics } from './views/Metrics';
import { ProjectPage } from './views/ProjectDetail';
import { FirewallDialog } from './views/FirewallDialog';
import { Graph } from './views/Graph';
import { Projects } from './views/Projects';

// The board editor is large; it loads only when a board is opened.
const Board = lazy(() => import('./views/Board'));

const VIEWS = ['today', 'projects', 'inbox', 'studio', 'graph', 'freezer', 'reset', 'metrics'] as const;
type View = (typeof VIEWS)[number];
const LABELS: Record<View, string> = {
  today: 'Today',
  projects: 'Projects',
  inbox: 'Inbox',
  studio: 'Studio',
  graph: 'Graph',
  freezer: 'Freezer',
  reset: 'Weekly reset',
  metrics: 'Metrics',
};
/** Phone tab bar: five tabs, no overflow. Freezer is reached from Studio; weekly reset and metrics from Today. */
const TABS: View[] = ['today', 'projects', 'inbox', 'studio', 'graph'];
const TAB_LABEL: Partial<Record<View, string>> = {};

/** `#graph:<node id>` focuses the graph; `#project:<id>` opens a project page; `#board:<node id>` opens a node's board. */
type Route = View | 'project' | 'board';
const viewFromHash = (): Route => {
  const h = location.hash.slice(1).split(':')[0];
  if (h === 'project' || h === 'board') return h;
  return VIEWS.includes(h as View) ? (h as View) : 'today';
};
const focusFromHash = () => {
  const m = location.hash.match(/^#(?:graph|project|board):(.+)$/);
  return m ? m[1] : undefined;
};

export function App() {
  const { db, act, demo } = useStore();
  const [view, setView] = useState<Route>(viewFromHash);
  const [focus, setFocus] = useState(focusFromHash);
  const [firewallId, setFirewallId] = useState<string | null>(null);
  const [captureSheet, setCaptureSheet] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  // The inline toolbar title appears only once the large title has scrolled away, as in iOS.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 48);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const onHash = () => {
      setView(viewFromHash());
      setFocus(focusFromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const inboxCount = db.projects.filter((p) => p.state === 'inbox').length;
  const running = openSession(db);
  const onCapture = (t: string, w: string) => act((d, n) => capture(d, t, w, n));

  return (
    <UiCtx.Provider value={{ openProject: (pid) => (location.hash = `project:${pid}`), openFirewall: setFirewallId }}>
      <div className={`shell${scrolled ? ' scrolled' : ''}`}>
        <aside className="sidebar glass">
          <div className="brand">
            EDP <span>Engine</span>
          </div>
          <nav aria-label="Sections">
            {VIEWS.map((v) => (
              <a key={v} href={`#${v}`} className="side-item" aria-current={v === view ? 'page' : undefined}>
                <Icon name={v} />
                <span className="side-label">{LABELS[v]}</span>
                {v === 'inbox' && inboxCount > 0 && <span className="side-count">{inboxCount}</span>}
                {v === 'today' && running && <span className="live-dot" aria-label="session running" />}
              </a>
            ))}
          </nav>
        </aside>

        <div className="content">
          <header className="toolbar glass">
            <span className="toolbar-title">{view === 'project' || view === 'board' ? [...db.projects, ...db.notes].find((n) => n.id === focus)?.title ?? '' : LABELS[view]}</span>
            <CaptureBar onCapture={onCapture} />
            <button className="icon-button capture-open" onClick={() => setCaptureSheet(true)} aria-label="Capture">
              <Icon name="plus" />
            </button>
          </header>
          <main className={view === 'board' ? 'main wide' : 'main'}>
            {demo && (
              <p className="demo-banner" role="note">
                <strong>Demo data.</strong> A two-week story in ~/.edp-engine/demo.json. Your real brain is untouched; run <code>npm run demo</code> again to reset it.
              </p>
            )}
            {view !== 'project' && view !== 'board' && <h1 className="large-title">{LABELS[view]}</h1>}
            {view === 'board' && focus && (
              <Suspense fallback={<p className="muted">Loading board…</p>}>
                <Board key={focus} nodeId={focus} />
              </Suspense>
            )}
            {view === 'project' && focus && <ProjectPage id={focus} />}
            {view === 'today' && <Today />}
            {view === 'projects' && <Projects />}
            {view === 'inbox' && <Inbox />}
            {view === 'studio' && <Studio />}
            {view === 'graph' && <Graph focus={focus} />}
            {view === 'freezer' && <Freezer />}
            {view === 'reset' && <WeeklyReset onDone={() => (location.hash = 'today')} />}
            {view === 'metrics' && <Metrics />}
          </main>
        </div>

        <nav className="tabbar glass" aria-label="Sections">
          {TABS.map((v) => (
            <a
              key={v}
              href={`#${v}`}
              className="tab"
              aria-current={v === view || (v === 'studio' && view === 'freezer') ? 'page' : undefined}
            >
              <span className="tab-icon">
                <Icon name={v} size={24} />
                {v === 'today' && running && <span className="live-dot" aria-label="session running" />}
              </span>
              <span className="tab-label">{TAB_LABEL[v] ?? LABELS[v]}</span>
            </a>
          ))}
        </nav>

        {captureSheet && (
          <Modal title="Capture" onClose={() => setCaptureSheet(false)}>
            <CaptureBar onCapture={onCapture} stacked onDone={() => setCaptureSheet(false)} />
          </Modal>
        )}
        {firewallId && <FirewallDialog id={firewallId} onClose={() => setFirewallId(null)} />}
      </div>
    </UiCtx.Provider>
  );
}

/** Single capture inbox: record the idea and why it matters; don't sort while the thought is hot. */
function CaptureBar({
  onCapture,
  stacked = false,
  onDone,
}: {
  onCapture: (title: string, why: string) => string[];
  stacked?: boolean;
  onDone?: () => void;
}) {
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [flash, setFlash] = useState(false);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (stacked) {
      ref.current?.focus();
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select');
      if (e.key === '/' && !typing) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [stacked]);

  return (
    <form
      className={`capture ${stacked ? 'stacked' : 'inline'} ${flash ? 'flash' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (onCapture(title, why).length) return;
        setTitle('');
        setWhy('');
        setFlash(true);
        setTimeout(() => setFlash(false), 600);
        if (onDone) onDone();
        else ref.current?.focus();
      }}
    >
      <input
        ref={ref}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={stacked ? 'Idea or obligation' : 'Capture an idea or obligation  /'}
        aria-label="Capture an idea or obligation"
      />
      {stacked ? (
        <AutoText value={why} onChange={setWhy} placeholder="Why it matters (optional)" aria-label="Why it matters" />
      ) : (
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Why it matters (optional)" aria-label="Why it matters" />
      )}
      <button type="submit" className="primary" disabled={!title.trim()}>
        {flash ? 'Captured' : 'Capture'}
      </button>
    </form>
  );
}
