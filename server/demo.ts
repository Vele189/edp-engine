import * as E from '../src/engine/engine';
import * as G from '../src/engine/graph';
import type { Capacity, Db, FirewallReview, Layer, NextAction, NoteKind, OutputKind, Relation, ReentryCard } from '../src/engine/types';

/**
 * Two weeks of a believable life, played through the real engine rules at simulated times:
 * Week 0 baseline → week 1 (capture + re-entry cards) → week 2 (firewall + weekly reset).
 * Because every step goes through the engine, the demo cannot contain a state the engine forbids.
 */
export function buildDemo(today = new Date()): Db {
  const DAY = 86_400_000;
  const midnight = new Date(today);
  midnight.setHours(0, 0, 0, 0);
  const at = (day: number, h: number, m = 0) => new Date(midnight.getTime() + day * DAY + (h * 60 + m) * 60_000);
  const date = (day: number) => E.isoDate(at(day, 12));

  let db = E.emptyDb();
  const id: Record<string, string> = {};

  const capture = (key: string, title: string, why: string, t: Date) => {
    db = E.capture(db, title, why, t);
    id[key] = db.projects[0].id;
  };
  const card = (key: string, c: Partial<ReentryCard>, t: Date) => {
    const p = E.getProject(db, id[key]);
    db = E.updateProject(db, p.id, { card: { ...p.card, ...c } }, t);
  };
  const next = (verb: string, object: string, location: string, done: string, energy: Capacity = 'medium'): NextAction => ({
    verb,
    object,
    location,
    done,
    energy,
  });
  const move = (key: string, to: Parameters<typeof E.transition>[2], opts: E.TransitionOpts, t: Date) => {
    db = E.transition(db, id[key], to, opts, t);
  };
  const firewall = (key: string, gates: Omit<FirewallReview, 'at' | 'decision'>, decision: FirewallReview['decision'], layer: Layer | undefined, t: Date) => {
    db = E.runFirewall(db, id[key], gates, decision, { layer }, t);
  };
  const work = (
    key: string,
    start: Date,
    planned: number,
    actual: number,
    capacity: Capacity,
    quick: boolean | undefined,
    output: string,
    kind: OutputKind | 'none',
    nextAction?: NextAction,
    extra: { blocker?: string; file?: string; thought?: string; bodyDouble?: boolean } = {},
  ) => {
    db = E.startSession(db, id[key], capacity, planned, start, extra.bodyDouble);
    const s = E.openSession(db)!;
    if (quick !== undefined) db = E.markResume(db, s.id, quick);
    const p = E.getProject(db, id[key]);
    db = E.closeSession(
      db,
      s.id,
      {
        output,
        outputKind: kind,
        blocker: extra.blocker ?? '',
        next: nextAction ?? p.card.next,
        file: extra.file,
        lastThought: extra.thought ?? '',
        decision: 'rotate',
      },
      new Date(start.getTime() + actual * 60_000),
    );
  };
  const note = (key: string, title: string, kind: NoteKind, body: string, t: Date) => {
    id[key] = E.newId();
    db = G.createNote(db, { title, body, kind, source: 'chat' }, t, id[key]);
  };
  const link = (a: string, relation: Relation, b: string, why: string, t: Date) => {
    db = G.link(db, id[a], id[b], relation, why, 'claude', t);
  };
  const pitStop = (what: string, planned: number, start: Date, actual: number) => {
    db = E.startPitStop(db, what, planned, start);
    db = E.endPitStop(db, new Date(start.getTime() + actual * 60_000));
  };

  // ---------- Week 0: baseline ----------
  db = E.setBaseline(db, { restartDelayMin: 25, missesPerWeek: 2, outputsPerWeek: 2, planningDisplaces: 'often' }, at(-15, 20));

  // ---------- Day -14: pilot starts with a brain dump in chat ----------
  db = { ...db, pilotStartedAt: at(-14, 9).toISOString() };
  capture('ep', 'Synth EP', 'Four tracks I keep circling back to; my creative outlet', at(-14, 9, 5));
  capture('client', 'Client site redesign', "Thandi's studio site; pays this month's rent", at(-14, 9, 6));
  capture('tax', 'Quarterly tax return', 'Penalty if late', at(-14, 9, 7));
  capture('pixel', 'Pixel-art palette tool', 'Curious whether palette-first drawing works', at(-14, 9, 8));
  capture('rust', 'Learn Rust', 'Keeps coming up', at(-14, 9, 9));
  capture('portfolio', 'Portfolio refresh', 'Last updated two years ago', at(-14, 9, 10));
  capture('nft', 'NFT drop for the EP', 'Saw someone else do it', at(-14, 9, 11));
  capture('cover', 'Mixtape cover art', "Lebo's mixtape; promised by the 22nd", at(-14, 9, 12));
  capture('licence', "Renew driver's licence", 'Expires next month', at(-14, 9, 13));

  note('evenings', 'Evenings are for music', 'decision', 'Client work stays in daytime blocks; evenings are protected for creative work.', at(-14, 9, 20));
  note('thandi', 'Thandi (client)', 'person', 'Runs the studio. Prefers Friday check-ins; replies fast on WhatsApp.', at(-14, 9, 21));
  link('evenings', 'supports', 'ep', 'Protected evenings are when the EP actually gets made', at(-14, 9, 22));
  link('evenings', 'context-for', 'client', 'Client work is boxed into daytime because of this decision', at(-14, 9, 22));
  link('thandi', 'context-for', 'client', 'Main contact and decision maker for the site', at(-14, 9, 23));

  // Real obligations go straight to the firewall and become anchors.
  move('tax', 'cooling', { reason: 'deadline', note: 'Legal obligation' }, at(-14, 10));
  card('tax', { outcome: 'Return filed on eFiling', currentState: 'Nothing gathered', next: next('Gather', 'the three payslips', 'Downloads', 'all three in one folder', 'low') }, at(-14, 10, 1));
  db = E.updateProject(db, id.tax, { deadline: date(2) }, at(-14, 10, 1));
  firewall('tax', { reality: 'Takes two evenings from the EP', evidence: 'Legal obligation; penalty if late', cost: 'About 3 hours', exit: 'Hire the accountant if not started by the 25th' }, 'promote', 'anchor', at(-14, 10, 5));

  move('licence', 'cooling', { reason: 'deadline', note: 'Legal obligation' }, at(-14, 10, 10));
  card('licence', { outcome: 'Licence renewed', currentState: 'Not booked', next: next('Book', 'a renewal slot', 'the online booking site', 'confirmation email received', 'low') }, at(-14, 10, 11));
  db = E.updateProject(db, id.licence, { deadline: date(9) }, at(-14, 10, 11));
  firewall('licence', { reality: 'One morning off client work', evidence: 'Expires next month', cost: 'Half a day + fee', exit: 'None: it has to happen' }, 'promote', 'anchor', at(-14, 10, 12));

  // Promised work enters the Active Studio.
  move('cover', 'cooling', { reason: 'deadline', note: 'Promised to Lebo' }, at(-14, 10, 20));
  card('cover', { outcome: 'Cover delivered to Lebo', currentState: 'Brief only', next: next('Sketch', 'three thumbnails', 'Procreate', 'three options on one canvas', 'medium') }, at(-14, 10, 21));
  firewall('cover', { reality: 'Two afternoons this week', evidence: 'Lebo already sent the brief', cost: '6 hours', exit: 'If the brief changes twice, hand it back' }, 'promote', 'studio', at(-14, 10, 25));

  move('client', 'cooling', { reason: 'evidence', note: 'Signed quote' }, at(-14, 10, 30));
  card('client', {
    outcome: 'New site live with a booking page',
    currentState: 'Old site, no booking',
    next: next('Fix', 'the nav overflow bug', '~/work/client/src/Nav.tsx', 'menu fits at 375px', 'high'),
    files: ['~/work/client'],
  }, at(-14, 10, 31));
  firewall('client', { reality: 'Daytime only; the evenings rule protects the EP', evidence: 'Signed quote and deposit paid', cost: '30 hours over three weeks', exit: 'If scope grows past the quote, renegotiate first' }, 'promote', 'studio', at(-14, 10, 35));

  // Curiosities stay small: reversible experiments with a time cap.
  move('ep', 'experiment', { reason: 'test', experiment: { question: 'Can I finish a 2-minute loop in one hour?', timeCapMin: 60 } }, at(-14, 11));
  move('pixel', 'experiment', { reason: 'test', experiment: { question: 'Would I use palette-first drawing twice in a week?', timeCapMin: 45 } }, at(-14, 11, 5));
  move('nft', 'cooling', { reason: 'evidence', note: 'Substantial commitment proposed' }, at(-14, 11, 30));

  work('cover', at(-14, 14), 60, 75, 'high', false, 'Three thumbnail sketches', 'tested', next('Pick', 'the strongest thumbnail', 'cover.procreate', 'one chosen, others archived', 'medium'), { file: '~/art/mixtape/cover.procreate' });

  // ---------- Day -13 ----------
  db = E.setDailyOpen(db, 'Fix the mobile nav', id.client, at(-13, 8, 50));
  work('client', at(-13, 10), 60, 70, 'high', false, 'Header and nav rebuilt; overflow remains on small phones', 'none', undefined, { blocker: 'Unsure how Thandi wants the mobile menu' });
  firewall('nft', { reality: 'Would eat EP evenings', evidence: 'None: nobody is asking for it', cost: 'Wallet setup, marketing, fees', exit: 'n/a' }, 'decline', undefined, at(-13, 18));
  db = E.updateProject(db, id.ep, { experiment: { ...E.getProject(db, id.ep).experiment!, result: 'Yes: a 2-minute loop in 55 minutes. The bass sounds thin.' } }, at(-13, 20, 25));
  move('ep', 'cooling', { reason: 'test', note: 'Test complete' }, at(-13, 20, 30));

  // ---------- Day -12 ----------
  db = E.setDailyOpen(db, 'Finish the mixtape cover', id.cover, at(-12, 8, 45));
  work('tax', at(-12, 9, 30), 15, 20, 'low', true, 'Two of three payslips gathered', 'none', next('Download', 'the March payslip', 'the employer portal', 'all three in the folder', 'low'));
  work('cover', at(-12, 13), 60, 60, 'high', true, 'Final cover coloured and exported', 'shipped');
  move('cover', 'completed', { reason: 'outcome', completion: 'Cover delivered to Lebo two days early' }, at(-12, 15));
  pitStop('Clean the desk, charge the controller', 15, at(-12, 16), 12);
  card('ep', {
    outcome: 'Release a 4-track EP',
    currentState: 'One 2-minute loop',
    next: next('Open', 'track1.als', 'Ableton', 'bassline recorded', 'medium'),
    files: ['~/music/ep/track1.als'],
  }, at(-12, 20, 55));
  firewall('ep', { reality: 'Uses the protected evenings, nothing else', evidence: 'The experiment finished a loop in 55 minutes', cost: 'Evenings, maybe new monitors', exit: 'If no track is finished in 4 weeks, shrink to a 2-track EP' }, 'promote', 'studio', at(-12, 21));
  note('resampling', 'Resampling bass chains', 'insight', 'Resampling is faster than patching synths from scratch for bass design.', at(-12, 21, 10));
  link('resampling', 'context-for', 'ep', 'The fix for the thin bass the experiment exposed', at(-12, 21, 11));

  // ---------- Day -11 ----------
  work('client', at(-11, 10), 60, 55, 'high', true, 'Mobile menu fixed at 375px', 'solved', next('Build', 'the booking page', '~/work/client/src/Booking.tsx', "form submits to Thandi's email", 'high'));
  work('ep', at(-11, 20), 60, 90, 'high', true, 'Bassline recorded with resampling', 'tested', next('Arrange', 'the track 1 drums', 'Ableton', '8-bar intro quantized', 'medium'), { thought: 'Try the 909 kit' });
  note('overrun', 'Ran 30 minutes over on the EP', 'context', 'Stopped at 21:30 instead of 21:00 and skipped dinner. The hyperfocus check helped me stop.', at(-11, 21, 40));
  link('overrun', 'context-for', 'ep', 'A pattern to watch on EP evenings', at(-11, 21, 41));

  // ---------- Day -10 / -9: a third studio slot, through the firewall ----------
  work('tax', at(-10, 9, 30), 15, 15, 'low', true, 'All three payslips in the folder', 'obligation', next('Fill', 'the return', 'SARS eFiling', 'return submitted', 'medium'));
  move('portfolio', 'cooling', { reason: 'evidence', note: 'Two clients asked for recent work' }, at(-10, 9));
  card('portfolio', {
    outcome: 'Portfolio with three recent projects',
    currentState: 'Old site from 2024',
    next: next('Export', 'three case-study images', 'the Figma portfolio file', '3 PNGs in /portfolio/img', 'low'),
  }, at(-10, 9, 5));
  firewall('portfolio', { reality: 'Takes Sunday mornings', evidence: 'Two clients asked for recent work', cost: 'About 6 hours', exit: 'If not live in two weeks, ship a one-page version' }, 'promote', 'studio', at(-9, 10));
  link('client', 'supports', 'portfolio', 'The new client site becomes the strongest case study', at(-9, 10, 5));
  note('pixelref', 'Pixel tools I admire', 'reference', 'Aseprite and Pyxel Edit: palette-first workflows.', at(-9, 19));
  link('pixel', 'inspired-by', 'pixelref', 'The tool idea grew out of using these palette-first editors', at(-9, 19, 1));

  // ---------- Day -8 ----------
  work('portfolio', at(-8, 10), 30, 30, 'low', true, 'Three images exported', 'none', next('Write', 'the client-site case study', 'Notion draft', '300 words', 'medium'));
  work('ep', at(-8, 20), 60, 60, 'medium', true, 'Drums arranged', 'tested', next('Mix', 'a rough of track 1', 'Ableton', 'rough.wav bounced', 'medium'));
  db = E.updateProject(db, id.pixel, { experiment: { ...E.getProject(db, id.pixel).experiment!, result: 'Used it twice. Fun, but not urgent.' } }, at(-8, 21));
  move('pixel', 'cooling', { reason: 'test', note: 'Test complete' }, at(-8, 21, 5));
  firewall('pixel', { reality: 'Would need EP evenings', evidence: 'Used it twice in a week', cost: 'Weeks of tooling work', exit: 'Revisit after the EP ships' }, 'defer', undefined, at(-8, 21, 10));

  // ---------- Day -7: weekly reset ----------
  db = E.saveWeeklyReview(db, 25, [{ what: "Sent Thandi's invoice late", cause: 'cues', note: 'Add invoices to the Friday check-in' }], 'Capture and cards work. The firewall felt heavy for tiny things.', at(-7, 17));
  db = E.setMechanism(db, 'bodyDoubling', 'trial', 'Try co-working calls for client work', at(-7, 17, 20));
  capture('podcast', 'Podcast with Lebo', 'Lebo asked after the cover', at(-7, 18));
  note('lebo', 'Lebo (musician friend)', 'person', 'Mixtape artist. Asked about doing a podcast together.', at(-7, 18, 1));
  link('lebo', 'context-for', 'cover', 'Commissioned the mixtape cover', at(-7, 18, 2));
  link('lebo', 'context-for', 'podcast', 'Proposed the podcast', at(-7, 18, 2));

  // ---------- Day -6 / -5: the trio is full, so the podcast waits ----------
  move('podcast', 'cooling', { reason: 'evidence', note: 'Lebo is keen' }, at(-6, 9));
  work('client', at(-6, 10), 60, 60, 'high', true, 'Booking form submits', 'solved', next('Style', 'the booking page', 'Booking.tsx', "matches Thandi's mockup", 'medium'), { bodyDouble: true });
  db = E.setDailyOpen(db, 'Rough mix of track 1', id.ep, at(-5, 8, 40));
  firewall('podcast', { reality: 'Would need Tuesday evenings: conflicts with the EP', evidence: 'Only an idea so far', cost: 'Three hours a week plus editing', exit: 'Revisit after the EP release' }, 'defer', undefined, at(-5, 9));
  link('podcast', 'conflicts-with', 'ep', 'Both would need the protected evenings', at(-5, 9, 1));
  pitStop('Gather samples for track 2', 30, at(-5, 19, 20), 38);
  work('ep', at(-5, 20), 60, 50, 'medium', true, 'Rough mix of track 1 bounced', 'tested', next('Write', 'the track 2 bassline', 'Ableton track2.als', '8 bars recorded', 'medium'), { file: '~/music/ep/track2.als' });

  // ---------- Day -4 / -3: pause protocol ----------
  work('client', at(-4, 10), 60, 55, 'medium', true, 'Booking page styled', 'solved', next('Send', 'the staging link', 'WhatsApp to Thandi', 'Thandi replies', 'low'), { bodyDouble: true });
  work('portfolio', at(-4, 11, 30), 30, 30, 'low', false, 'Case study half drafted', 'none', undefined, { blocker: 'Not sure which photos Thandi allows' });
  move('portfolio', 'paused', { reason: 'capacity', note: "Waiting on photo permission from Thandi; rotating to the client deadline" }, at(-3, 9));
  link('portfolio', 'depends-on', 'thandi', "Needs Thandi's permission to use the studio photos", at(-3, 9, 1));
  work('ep', at(-3, 20), 60, 60, 'medium', true, 'Track 2 bassline recorded', 'tested', next('Program', 'the track 2 drums', 'Ableton track2.als', '16 bars looped', 'medium'));

  // ---------- Day -2 / -1 ----------
  capture('monitors', 'Buy studio monitors', 'Mixes translate badly on phone speakers', at(-2, 8, 30));
  link('monitors', 'supports', 'ep', 'Better monitors make the EP mixes translate', at(-2, 8, 31));
  link('monitors', 'depends-on', 'tax', 'Waiting on the tax refund before spending', at(-2, 8, 32));
  move('monitors', 'cooling', { reason: 'evidence', note: 'Real spend proposed; let it cool until the refund lands' }, at(-2, 8, 35));
  db = E.setDailyOpen(db, "Get Thandi's approval", id.client, at(-2, 8, 40));
  work('client', at(-2, 10), 30, 25, 'low', true, 'Staging link sent; Thandi approved', 'solved', next('Deploy', 'the site to production', 'the Netlify dashboard', 'live URL loads', 'medium'), { bodyDouble: true });
  work('tax', at(-2, 18), 30, 40, 'medium', true, 'Return 80% filled in', 'none', undefined, { blocker: 'Missing the medical aid certificate' });
  work('ep', at(-1, 20), 60, 55, 'medium', true, 'Track 2 drums programmed', 'tested', next('Record', 'a cleaner track 2 bassline take', 'Ableton track2.als', 'clean take kept', 'medium'));
  link('client', 'conflicts-with', 'ep', 'Launch week could spill into the protected evenings', at(-1, 21));
  capture('teaser', 'Short teaser clips for the EP', 'Saw a 15-second clip format that fits the music', at(-1, 21, 30));
  move('teaser', 'experiment', { reason: 'test', experiment: { question: 'Does one 15-second teaser get 10 saves?', timeCapMin: 30 } }, at(-1, 21, 35));
  link('teaser', 'supports', 'ep', 'Teasers would build an audience before the release', at(-1, 21, 36));

  // ---------- Today: the daily open protects the deadline first ----------
  db = E.setDailyOpen(db, 'File the tax return', id.tax, new Date(today.getTime() - 10 * 60_000));
  return db;
}
