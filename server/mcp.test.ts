import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edp-mcp-'));
const dbPath = path.join(dir, 'db.json');
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError };
}

beforeAll(async () => {
  client = new Client({ name: 'test', version: '0' });
  await client.connect(
    new StdioClientTransport({
      command: path.join(root, 'node_modules/.bin/tsx'),
      args: [path.join(root, 'server/mcp.ts')],
      env: { ...process.env, EDP_DB: dbPath, EDP_ALLOW_DIRS: dir } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
}, 20_000);

afterAll(async () => {
  await client?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('exposes the engine tools and usage instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['edp_overview', 'edp_capture', 'edp_firewall', 'edp_start_session', 'edp_close_session', 'edp_configure']),
    );
    expect(client.getInstructions()).toMatch(/edp_overview first/);
  });

  it('runs an idea from capture to a paused project with a beacon', async () => {
    expect((await call('edp_capture', { items: [{ title: 'Synth EP', why: 'creative outlet' }, { title: 'Pay rent' }] })).text).toMatch(
      /Captured 2/,
    );
    await call('edp_move', { project: 'synth', to: 'cooling', reason: 'evidence' });

    // Promotion is blocked until the card has an outcome and a complete next action.
    const gates = { reality: 'Less gaming', evidence: 'One finished track', cost: '4h/week', exit: 'No track in 3 weeks' };
    const blocked = await call('edp_firewall', { project: 'synth', ...gates, decision: 'promote' });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/desired outcome/);

    await call('edp_update_project', {
      project: 'synth',
      outcome: 'Release a 4-track EP',
      next: { verb: 'Open', object: 'track2.als', location: 'Ableton', done: 'bassline recorded', energy: 'medium' },
      add_files: ['~/music/ep/track2.als'],
    });
    const promoted = await call('edp_firewall', { project: 'synth', ...gates, decision: 'promote' });
    expect(promoted.text).toMatch(/promote/);
    expect(promoted.text).toMatch(/cooled 0h/);

    expect((await call('edp_route', { capacity: 'medium' })).text).toMatch(/Synth EP/);
    expect((await call('edp_start_session', { project: 'synth', capacity: 'medium', minutes: 25 })).text).toMatch(/track2\.als/);
    expect((await call('edp_overview')).text).toMatch(/RUNNING SESSION: \[\w+\] Synth EP/);
    await call('edp_rate_reentry', { quick: true });

    const pausedNoReason = await call('edp_close_session', { output: 'Recorded bassline take', decision: 'pause' });
    expect(pausedNoReason.isError).toBe(true);
    const closed = await call('edp_close_session', {
      output: 'Recorded bassline take',
      output_kind: 'tested',
      next: { object: 'track2.als', done: 'drums quantized' },
      decision: 'pause',
      pause_reason: 'client deadline this week',
    });
    expect(closed.text).toMatch(/paused\/studio/);
    expect(closed.text).toMatch(/done when drums quantized/);

    const detail = await call('edp_get_project', { project: 'synth' });
    expect(detail.text).toMatch(/current state: Recorded bassline take/);
    expect((await call('edp_metrics', { weeks: 1 })).text).toMatch(/100% of 1/);
  });

  it('reports ambiguous references instead of guessing', async () => {
    await call('edp_capture', { items: [{ title: 'Synth patch library' }] });
    const res = await call('edp_get_project', { project: 'synth' });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/ambiguous/);
  });

  it('builds the brain: notes, reasoned links, groups, recall', async () => {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['edp_note', 'edp_link', 'edp_unlink', 'edp_graph_search', 'edp_graph_node', 'edp_graph_overview']));
    expect(client.getInstructions()).toMatch(/Never link on keyword overlap/);

    const note = await call('edp_note', {
      action: 'create',
      title: 'Resampling bass chains',
      body: 'User finds resampling faster than synth patching for bass design.',
      kind: 'insight',
      links: [{ to: 'Synth EP', relation: 'context-for', why: 'Technique the user wants to use for the EP basslines' }],
    });
    expect(note.text).toMatch(/context for Synth EP/);

    const weak = await call('edp_link', { from: 'Pay rent', to: 'Synth EP', relation: 'same-theme', why: 'money' });
    expect(weak.isError).toBe(true);

    const captured = await call('edp_capture', {
      items: [{ title: 'Buy studio monitors', why: 'mixes translate badly', links: [{ to: 'Synth EP', relation: 'supports', why: 'Better monitors make the EP mixes translate' }] }],
    });
    expect(captured.text).toMatch(/supports Synth EP/);

    expect((await call('edp_graph_search', { query: 'bass design technique' })).text).toMatch(/Resampling bass chains/);
    const recall = await call('edp_graph_node', { node: 'Synth EP' });
    expect(recall.text).toMatch(/LINKS \(2\)/);
    expect(recall.text).toMatch(/Better monitors make the EP mixes translate/);

    const overview = await call('edp_graph_overview', {});
    expect(overview.text).toMatch(/GROUP "Synth EP" \(3\)/);
    expect(overview.text).toMatch(/Pay rent/);

    await call('edp_unlink', { from: 'monitors', to: 'Synth EP' });
    expect((await call('edp_graph_node', { node: 'Synth EP' })).text).toMatch(/LINKS \(1\)/);
    expect((await call('edp_note', { action: 'update', note: 'Synth EP', body: 'x' })).isError).toBe(true);
  });

  it('queues plan content on a board and reads it back', async () => {
    expect((await call('edp_board', { node: 'Synth EP', action: 'read' })).text).toMatch(/no board yet/);
    const added = await call('edp_board', {
      node: 'Synth EP',
      action: 'add',
      items: [
        { type: 'heading', text: 'Release plan' },
        { type: 'sticky', text: 'Week 1: finish track 2', color: 'yellow' },
        { type: 'mermaid', text: 'flowchart LR\n  A[Mix] --> B[Master] --> C[Release]' },
      ],
    });
    expect(added.text).toMatch(/Queued 3 item/);
    const read = await call('edp_board', { node: 'Synth EP', action: 'read' });
    expect(read.text).toMatch(/Release plan/);
    expect(read.text).toMatch(/\[diagram, not drawn yet\]/);
    expect((await call('edp_board', { node: 'Synth EP', action: 'add', items: [] })).isError).toBe(true);
    expect(fs.readdirSync(path.join(dir, 'boards')).filter((f) => f.endsWith('.json'))).toHaveLength(1);
  });

  it('knows where projects live in the workspace, read-only', async () => {
    const ws = path.join(dir, 'Documents');
    fs.mkdirSync(path.join(ws, 'synth-ep', 'src'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'synth-ep', 'README.md'), '# Synth EP\n\nFour tracks of resampled bass.\n');
    fs.writeFileSync(path.join(ws, 'synth-ep', 'src', 'mix.txt'), 'notes');
    fs.writeFileSync(path.join(ws, 'synth-ep', '.env'), 'SECRET=1');
    fs.mkdirSync(path.join(ws, 'portfolio'));

    expect((await call('edp_workspace', { action: 'get' })).text).toMatch(/No workspace root/);
    expect((await call('edp_workspace', { action: 'set', root: '/etc' })).isError).toBe(true);
    expect((await call('edp_workspace', { action: 'set', root: ws })).text).toMatch(/2 project folder/);
    const list = (await call('edp_workspace', { action: 'get' })).text;
    expect(list).toMatch(/synth-ep\/ +→ untracked/);
    expect(list).toMatch(/Four tracks of resampled bass/);

    expect((await call('edp_update_project', { project: 'Synth EP', folder: '../escape' })).isError).toBe(true);
    await call('edp_update_project', { project: 'Synth EP', folder: 'synth-ep' });
    expect((await call('edp_capture', { items: [{ title: 'Second EP', folder: 'synth-ep' }] })).text).toMatch(/already linked to "Synth EP"/);

    const ctx = (await call('edp_project_context', { project: 'Synth EP' })).text;
    expect(ctx).toContain(`FOLDER: ${path.join(ws, 'synth-ep')}`);
    expect(ctx).toMatch(/src\/mix.txt/);
    expect(ctx).toMatch(/Four tracks of resampled bass/);
    expect(ctx).not.toMatch(/SECRET|\.env/);
    expect(ctx).toMatch(/BOARD \(/);
    expect((await call('edp_workspace', { action: 'get' })).text).toMatch(/synth-ep\/ +→ \[\w+\] Synth EP/);
  });

  it('persists to the shared file with a revision counter', () => {
    const file = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    expect(file.rev).toBeGreaterThan(5);
    expect(file.db.version).toBe(3);
    expect(file.db.projects).toHaveLength(4);
    expect(file.db.notes).toHaveLength(1);
    expect(file.db.links).toHaveLength(1);
  });
});
