import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HISTORY_STATUS_NOTE, parseGeminiSession, parseOpenCodeSessions, readOtherAgents, resetOtherAgentCache } from '../src/data/otherAgents';
import { run } from '../src/data/git';

vi.mock('../src/data/git', () => ({ run: vi.fn() }));

const NOW = Date.parse('2026-11-16T16:00:00Z');
const DATE = '2026-11-16T15:00:00Z';
const NATIVE_ID = '11111111-1111-4111-8111-111111111111';
const metadata = { sessionId: NATIVE_ID, projectHash: 'hash', startTime: DATE, lastUpdated: DATE };
const message = (id: string, type: string, content: unknown) => ({ id, type, content, timestamp: DATE });
const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n');
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-other-agents-'));
  resetOtherAgentCache();
  vi.mocked(run).mockReset().mockResolvedValue({ ok: true, stdout: '[]', stderr: '', timedOut: false });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('Gemini history', () => {
  it('reads legacy JSON text parts, preserves native identity and never asserts liveness from recency', () => {
    const s = parseGeminiSession(JSON.stringify({ ...metadata, summary: 'Fix authentication', messages: [
      message('u1', 'user', [{ text: 'Fix\n authentication' }]),
      message('a1', 'gemini', [{ text: 'Fixed the login.' }, { text: 'Tests pass.' }, { functionCall: { name: 'secret' } }]),
    ] }), '/work/project', '/history/session.json');
    expect(s).toMatchObject({ provider: 'gemini', sessionId: `gemini:${NATIVE_ID}`, nativeSessionId: NATIVE_ID,
      title: 'Fix authentication', cwd: '/work/project', live: false, status: 'unknown', canResume: true,
      statusNote: HISTORY_STATUS_NOTE, lastPrompt: 'Fix authentication', recentPrompts: ['Fix authentication'],
      report: 'Fixed the login.\nTests pass.', transcriptPath: '/history/session.json' });
  });

  it('replays current JSONL metadata updates, patches, removals and rewinds without showing discarded answers', () => {
    const text = jsonl(metadata, message('u1', 'user', 'First task'), message('a1', 'gemini', 'Old answer'),
      { $patch: { id: 'a1', content: [{ text: 'Updated answer' }] } }, message('u2', 'user', 'Removed task'),
      message('a2', 'gemini', 'Discard this answer'), { $rewindTo: 'u2' },
      { $set: { summary: 'Current task', lastUpdated: '2026-11-16T15:30:00Z' } });
    expect(parseGeminiSession(`${text}\n{incomplete`, '/work/project')).toMatchObject({ title: 'Current task', report: 'Updated answer', recentPrompts: ['First task'], updatedAt: Date.parse('2026-11-16T15:30:00Z') });
    const removed = parseGeminiSession(jsonl(metadata, message('u1', 'user', 'One'), message('a1', 'gemini', 'Remove me'), { $patch: { removeIds: ['a1'], orderIds: ['u1'] } }), '/work/project');
    expect(removed?.report).toBeUndefined();
  });

  it('skips malformed sessions, unsafe native IDs, unknown folders and subagent histories', () => {
    expect(parseGeminiSession('not JSON', '/work/project')).toBeUndefined();
    expect(parseGeminiSession(JSON.stringify({ ...metadata, sessionId: '--resume' }), '/work/project')).toBeUndefined();
    expect(parseGeminiSession(JSON.stringify({ ...metadata, messages: [] }), 'opaque-project-hash')).toBeUndefined();
    expect(parseGeminiSession(JSON.stringify({ ...metadata, kind: 'subagent', messages: [] }), '/work/project')).toBeUndefined();
  });

  it('discovers owned project directories and registry mappings, excludes old history, and resolves project keys', async () => {
    const writeSession = (slug: string, sessionId: string, date = DATE) => {
      const dir = join(root, 'tmp', slug, 'chats');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `session-${sessionId}.json`);
      writeFileSync(path, JSON.stringify({ ...metadata, sessionId, lastUpdated: date, messages: [message('u1', 'user', 'Task')] }));
      return path;
    };
    writeSession('marker-project', 'marker');
    writeFileSync(join(root, 'tmp', 'marker-project', '.project_root'), '/work/project\n');
    writeSession('registry-project', 'registry');
    writeFileSync(join(root, 'projects.json'), JSON.stringify({ projects: { '/work/project/subtree': 'registry-project' } }));
    writeSession('unknown-project', 'unknown');
    const old = writeSession('marker-project', 'old', '2026-10-01T00:00:00Z');
    utimesSync(old, new Date('2026-10-01'), new Date('2026-10-01'));
    const resolveProjectKey = vi.fn(async () => '/work/project');
    const sessions = await readOtherAgents({ geminiDir: root, endedSessionDays: 7, now: NOW, resolveProjectKey });
    expect(sessions.map((s) => s.nativeSessionId).sort()).toEqual(['marker', 'registry']);
    expect(sessions.every((s) => s.projectKey === '/work/project' && s.status === 'unknown' && !s.live)).toBe(true);
    expect(resolveProjectKey).toHaveBeenCalledTimes(2);
  });
});

describe('OpenCode history', () => {
  it('reads the CLI listing and rejects malformed or unresumable identifiers', () => {
    const sessions = parseOpenCodeSessions(JSON.stringify([
      { id: 'ses_a123', directory: '/work/project', title: 'Fix styles', created: NOW - 60_000, updated: NOW },
      { id: '--option', directory: '/work/project', updated: NOW },
      { id: 'ses_missing_folder', updated: NOW },
    ]));
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ provider: 'opencode', nativeSessionId: 'ses_a123', sessionId: 'opencode:ses_a123', title: 'Fix styles', live: false, status: 'unknown', canResume: true, startedAt: NOW - 60_000, updatedAt: NOW });
    expect(parseOpenCodeSessions('broken output')).toEqual([]);
  });

  it('uses a bounded read-only CLI listing, caches polling and applies the age window', async () => {
    vi.mocked(run).mockResolvedValue({ ok: true, stdout: JSON.stringify([
      { id: 'ses_recent', directory: '/work/project', title: 'Current', updated: NOW },
      { id: 'ses_old', directory: '/work/project', title: 'Old', updated: NOW - 90 * 86_400_000 },
    ]), stderr: '', timedOut: false });
    const opts = { geminiDir: root, opencodeCommand: '/tools/opencode', endedSessionDays: 7, now: NOW };
    expect((await readOtherAgents(opts)).map((s) => s.nativeSessionId)).toEqual(['ses_recent']);
    await readOtherAgents({ ...opts, now: NOW + 15_000 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/tools/opencode', ['session', 'list', '--max-count', '100', '--format', 'json', '--pure'], { timeoutMs: 5000 });
    await readOtherAgents({ ...opts, now: NOW + 60_001 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('does not let unavailable or invalid CLI history prevent Gemini discovery', async () => {
    vi.mocked(run).mockResolvedValue({ ok: false, stdout: '', stderr: 'not installed', code: 'ENOENT', timedOut: false });
    const dir = join(root, 'tmp', 'project', 'chats');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(root, 'tmp', 'project', '.project_root'), '/work/project');
    writeFileSync(join(dir, 'session-one.jsonl'), jsonl(metadata, message('u1', 'user', 'Task')));
    const sessions = await readOtherAgents({ geminiDir: root, endedSessionDays: 7, now: NOW });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.provider).toBe('gemini');
  });
});
