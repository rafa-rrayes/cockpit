import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexRuntimeStatus, parseCodexTranscript, readCodex, readCodexRuntime, type CodexRuntimeThread } from '../src/data/codex';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-16T18:00:00Z');
const at = '2026-11-16T17:00:00Z';
const line = (type: string, payload: unknown) => `${JSON.stringify({ type, timestamp: at, payload })}\n`;
const meta = (id = ID, cwd = '/work/demo') => line('session_meta', { id, cwd, timestamp: at, cli_version: '0.167.2', git: { branch: 'feature' } });
const user = (text: string) => line('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
const agent = (text: string) => line('response_item', { type: 'message', role: 'assistant', phase: 'final', content: [{ type: 'output_text', text }] });
let dir: string;
let path: string;

beforeEach(() => {
  // macOS Unix socket paths are limited to 104 bytes; its default tmpdir is already long.
  dir = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'cockpit-codex-'));
  const sessions = join(dir, 'sessions', '2026', '11', '16');
  mkdirSync(sessions, { recursive: true });
  path = join(sessions, `rollout-2026-11-16T17-00-00-${ID}.jsonl`);
  writeFileSync(path, meta() + user('Build the session view') + agent('Built and verified.'));
  utimesSync(path, NOW / 1000, NOW / 1000);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = (runtime: CodexRuntimeThread[] | undefined = undefined, days = 7) => readCodex({ codexDir: dir, endedSessionDays: days, now: NOW, runtimeThreads: async () => runtime });

describe('Codex transcripts', () => {
  it('discovers saved sessions with provider identity, native resume ID and truthful unknown liveness', async () => {
    const result = await read();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ sessionId: `codex:${ID}`, provider: 'codex', nativeSessionId: ID, canResume: true, live: false, status: 'unknown', cwd: '/work/demo', projectKey: '/work/demo', title: 'Build the session view', lastPrompt: 'Build the session view', recentPrompts: ['Build the session view'], report: 'Built and verified.', gitBranch: 'feature', agentVersion: '0.167.2', transcriptPath: path });
    expect((result[0] as { statusNote?: string }).statusNote).toContain('live state is unavailable');
  });

  it('reads old event_msg text and ignores instruction wrappers, duplicate prompts and malformed records', () => {
    const t = parseCodexTranscript(meta() + user('# AGENTS.md instructions\n<INSTRUCTIONS>rules</INSTRUCTIONS>') + user('<environment_context>machine</environment_context>') + user('First task') + line('event_msg', { type: 'user_message', message: 'First task' }) + '\nnot json\n' + line('event_msg', { type: 'agent_message', message: 'Finished' }));
    expect(t?.prompts).toEqual(['First task']);
    expect(t?.report).toBe('Finished');
  });

  it('retains the child identity and folder when inherited history repeats parent metadata', () => {
    const t = parseCodexTranscript(meta() + meta(OTHER, '/work/parent') + user('Child task'), ID);
    expect(t).toMatchObject({ id: ID, cwd: '/work/demo', prompts: ['Child task'] });
  });

  it('bounds prompt and report sizes and keeps the five newest prompts', () => {
    const t = parseCodexTranscript(meta() + Array.from({ length: 9 }, (_, i) => user(`task ${i} ${'x'.repeat(500)}`)).join('') + agent('r'.repeat(30_000)));
    expect(t?.prompts).toHaveLength(5);
    expect(t?.prompts[0]).toMatch(/^task 8/);
    expect(t?.prompts[0]?.length).toBe(300);
    expect(t?.report?.length).toBe(20_000);
  });

  it('prunes old saved sessions but retains loaded threads, even with old transcripts', async () => {
    utimesSync(path, (NOW - 10 * 86_400_000) / 1000, (NOW - 10 * 86_400_000) / 1000);
    expect(await read()).toEqual([]);
    expect(await read([{ id: ID, status: { type: 'idle' } }])).toHaveLength(1);
  });

  it('supports missing directories, broken files and project resolution', async () => {
    writeFileSync(join(dir, 'sessions', 'broken.jsonl'), 'broken\n');
    const result = await readCodex({ codexDir: dir, endedSessionDays: 7, now: NOW, runtimeThreads: async () => undefined, resolveProjectKey: async () => '/work/main' });
    expect(result[0]?.projectKey).toBe('/work/main');
    expect(await readCodex({ codexDir: join(dir, 'missing'), endedSessionDays: 7, now: NOW })).toEqual([]);
  });

  it('reads the newest tail of a large rollout, ignores a partial last line, and refreshes after append', async () => {
    writeFileSync(path, meta() + user('Old task') + line('padding', { data: 'x'.repeat(3 * 1024 * 1024) }) + user('Newest task') + agent('Latest report') + '{"type":"event_msg"');
    let result = await read();
    expect(result[0]).toMatchObject({ lastPrompt: 'Newest task', report: 'Latest report' });
    appendFileSync(path, '\n' + user('Next task') + agent('Next report'));
    result = await read();
    expect(result[0]).toMatchObject({ lastPrompt: 'Next task', report: 'Next report' });
  });
});

describe('Codex runtime status', () => {
  it.skipIf(process.platform === 'win32')('reads status from an existing local daemon without loading, resuming or subscribing to threads', async () => {
    const control = join(dir, 'app-server-control');
    mkdirSync(control);
    const socket = join(control, 'app-server-control.sock');
    const server = createServer();
    const ws = new WebSocketServer({ server });
    ws.on('error', () => {}); // The listen Promise below reports server startup failures to the test.
    const methods: string[] = [];
    ws.on('connection', (client) => client.on('message', (raw) => {
      const r = JSON.parse(raw.toString());
      methods.push(r.method);
      if (r.method === 'initialize') client.send(JSON.stringify({ id: r.id, result: {} }));
      else if (r.method === 'thread/loaded/list') client.send(JSON.stringify({ id: r.id, result: { data: [ID] } }));
      else if (r.method === 'thread/read') {
        expect(r.params).toEqual({ threadId: ID, includeTurns: false });
        client.send(JSON.stringify({ id: r.id, result: { thread: { id: ID, cwd: '/work/demo', status: { type: 'active' } } } }));
      }
    }));
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
    try {
      expect(await readCodexRuntime(dir)).toEqual([{ id: ID, cwd: '/work/demo', status: { type: 'active' } }]);
      expect(methods).toEqual(['initialize', 'initialized', 'thread/loaded/list', 'thread/read']);
    } finally {
      for (const client of ws.clients) client.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('maps idle, busy, permission and user-input waits without timing guesses', () => {
    expect(codexRuntimeStatus({ id: ID, status: { type: 'idle' } })).toEqual({ live: true, status: 'idle' });
    expect(codexRuntimeStatus({ id: ID, status: { type: 'active', activeFlags: [] } })).toEqual({ live: true, status: 'busy' });
    expect(codexRuntimeStatus({ id: ID, status: { type: 'active', activeFlags: ['waitingOnApproval'] } })).toMatchObject({ live: true, status: 'waiting', waitingFor: 'permission approval' });
    expect(codexRuntimeStatus({ id: ID, status: { type: 'active', activeFlags: ['waitingOnUserInput'] } })).toMatchObject({ live: true, status: 'waiting', waitingFor: 'your answer' });
    expect(codexRuntimeStatus({ id: ID, status: { type: 'notLoaded' } })).toEqual({ live: false, status: 'ended' });
    expect(codexRuntimeStatus({ id: ID, status: { type: 'systemError' } })).toMatchObject({ live: true, status: 'unknown' });
  });

  it('discovers loaded threads before any local transcript exists', async () => {
    const result = await read([{ id: OTHER, cwd: '/work/new', name: 'Fresh Codex', createdAt: NOW / 1000, updatedAt: NOW / 1000, status: { type: 'active' } }]);
    expect(result.find((s) => s.sessionId === `codex:${OTHER}`)).toMatchObject({ title: 'Fresh Codex', live: true, status: 'busy', startedAt: NOW, updatedAt: NOW, recentPrompts: [] });
  });

  it('retains historical discovery if runtime querying fails', async () => {
    const result = await readCodex({ codexDir: dir, endedSessionDays: 7, now: NOW, runtimeThreads: async () => { throw new Error('daemon unavailable'); } });
    expect(result).toHaveLength(1);
    expect(result[0]?.status).toBe('unknown');
  });
});
