// Tests for the Claude Code adapter against test/fixtures/claude: a fake ~/.claude with the real file shapes
// (Claude Code 2.1.3xx) and invented content. Each test works on a fresh copy, so mtimes and appends are under control.
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanPrompt, NO_FOLDER_KEY, parseScriptMeta, readClaude, resetClaudeCache, type ReadClaudeOptions } from '../src/data/claude';
import type { ClaudeSession } from '../src/model';

const FIXTURE = join(__dirname, 'fixtures', 'claude');
const NOW = 1794600000000;
const ALIVE = new Set([101, 102, 103, 105]);
/** When the fixture processes started: their pid files say so in startedAt and procStart. */
const STARTED = 1794500000000;
const ID = {
  busy: '11111111-1111-4111-8111-111111111111',
  waiting: '22222222-2222-4222-8222-222222222222',
  worktree: '33333333-3333-4333-8333-333333333333',
  stale: '44444444-4444-4444-8444-444444444444',
  old: '55555555-5555-4555-8555-555555555555',
  cut: '66666666-6666-4666-8666-666666666666',
  nofile: '77777777-7777-4777-8777-777777777777',
  other: '88888888-8888-4888-8888-888888888888',
};

let dir: string;

const setMtime = (path: string, at: number) => utimesSync(path, at / 1000, at / 1000);
function setAllMtimes(root: string, at: number) {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) setAllMtimes(p, at);
    else setMtime(p, at);
  }
}
const transcript = (slug: string, id: string) => join(dir, 'projects', slug, `${id}.jsonl`);

const opts = (extra: Partial<ReadClaudeOptions> = {}): ReadClaudeOptions => ({
  claudeDir: dir,
  endedSessionDays: 7,
  now: NOW,
  isPidAlive: (pid) => ALIVE.has(pid),
  processStarts: async (pids) => new Map(pids.filter((p) => ALIVE.has(p)).map((p) => [p, STARTED])),
  ...extra,
});

async function read(extra: Partial<ReadClaudeOptions> = {}): Promise<Record<string, ClaudeSession>> {
  return Object.fromEntries((await readClaude(opts(extra))).map((s) => [s.sessionId, s]));
}

const humanLine = (id: string, text: string) =>
  `${JSON.stringify({ type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' }, cwd: '/work/big', sessionId: id, gitBranch: 'main', version: '2.1.323', timestamp: '2026-11-13T09:00:00.000Z' })}\n`;

beforeEach(() => {
  resetClaudeCache();
  dir = mkdtempSync(join(tmpdir(), 'cockpit-claude-'));
  cpSync(FIXTURE, dir, { recursive: true });
  setAllMtimes(dir, NOW - 60_000);
  setMtime(transcript('-work-demo', ID.old), NOW - 10 * 86_400_000);
  setMtime(transcript('-work-demo', ID.stale), NOW - 86_400_000);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('live sessions', () => {
  it('reads busy, waiting and idle sessions from live pid files', async () => {
    const s = await read();
    expect(s[ID.busy]).toMatchObject({ live: true, pid: 101, status: 'busy', name: 'demo-a1', cwd: '/work/demo', startedAt: 1794500000000, claudeVersion: '2.1.323' });
    expect(s[ID.busy]?.waitingFor).toBeUndefined();
    expect(s[ID.waiting]).toMatchObject({ live: true, status: 'waiting', waitingFor: 'permission prompt', title: 'Staging migration' });
    expect(s[ID.worktree]).toMatchObject({ live: true, status: 'idle' });
    expect(s[ID.busy]?.inVsCodeTerminal).toBeUndefined();
  });

  it('maps an unknown status to unknown and shows a live session that has no transcript yet', async () => {
    const s = (await read())[ID.nofile];
    expect(s).toMatchObject({ live: true, status: 'unknown', title: 'fresh-e5', cwd: '/work/fresh', recentPrompts: [], subagents: [], workflows: [] });
    expect(s?.transcriptPath).toBeUndefined();
  });

  it('treats a pid file whose process is gone as an ended session', async () => {
    const s = (await read())[ID.stale];
    expect(s).toMatchObject({ live: false, status: 'ended', title: 'Branch cleanup', updatedAt: NOW - 86_400_000 });
    expect(s?.pid).toBeUndefined();
    // Its background agent never wrote "finished", but it cannot outlive the process.
    expect(s?.subagents).toEqual([expect.objectContaining({ id: 'dddd000000000009', finished: true })]);
  });

  it('checks pids with process.kill and their start times with ps by default', async () => {
    const pidFile = join(dir, 'sessions', `${process.pid}.json`);
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, sessionId: ID.old, cwd: '/work/demo', status: 'idle', startedAt: Date.now(), updatedAt: Date.now() }));
    const defaults = { isPidAlive: undefined, processStarts: undefined, endedSessionDays: 30 };
    expect((await read(defaults))[ID.old]).toMatchObject({ live: true, status: 'idle' });
    // The same pid, but the file says its process started long before this one: an earlier process's file.
    writeFileSync(pidFile, JSON.stringify({ pid: process.pid, sessionId: ID.old, cwd: '/work/demo', status: 'idle', procStart: 'Mon Jan  5 10:00:00 2026', updatedAt: Date.now() }));
    expect((await read(defaults))[ID.old]).toMatchObject({ live: false, status: 'ended' });
  });

  it('treats a pid file as ended when its pid now belongs to a later process', async () => {
    const later = (pids: number[]) => new Map(pids.filter((p) => ALIVE.has(p)).map((p) => [p, p === 102 ? STARTED + 3_600_000 : STARTED]));
    const s = await read({ processStarts: async (pids) => later(pids) });
    expect(s[ID.waiting]).toMatchObject({ live: false, status: 'ended' });
    expect(s[ID.waiting]?.waitingFor).toBeUndefined();
    expect(s[ID.busy]).toMatchObject({ live: true, status: 'busy' });
    // A file without procStart is judged by startedAt: it cannot belong to a process that started after it.
    writeFileSync(join(dir, 'sessions', '101.json'), JSON.stringify({ pid: 101, sessionId: ID.busy, cwd: '/work/demo', status: 'busy', startedAt: STARTED - 86_400_000 }));
    expect((await read())[ID.busy]).toMatchObject({ live: false, status: 'ended' });
    // A pid that ps does not list has no process; without ps at all, the pid check is all there is.
    expect((await read({ processStarts: async () => new Map() }))[ID.worktree]?.live).toBe(false);
    expect((await read({ processStarts: async () => undefined }))[ID.worktree]?.live).toBe(true);
  });

  it('sorts live sessions first, then by last activity', async () => {
    const list = await readClaude(opts());
    const liveCount = list.filter((x) => x.live).length;
    expect(list.slice(0, liveCount).every((x) => x.live)).toBe(true);
    const ended = list.slice(liveCount).map((x) => x.updatedAt ?? 0);
    expect([...ended].sort((a, b) => b - a)).toEqual(ended);
  });
});

describe('transcripts', () => {
  it('prefers the custom title over the AI title, and the newest of each', async () => {
    expect((await read())[ID.busy]?.title).toBe('Settings: dark mode');
  });

  it('lists only what the person typed, newest first, at most 5, cut to about 300 characters', async () => {
    const s = (await read())[ID.busy];
    const prompts = s?.recentPrompts ?? [];
    expect(prompts).toHaveLength(5);
    expect(prompts[0]).toMatch(/^Prompt six: this screenshot shows the bug x+…$/);
    expect(prompts[0]?.length).toBeLessThanOrEqual(300);
    // A resent prompt is listed once; pasted blocks and system reminders are not the person's words.
    expect(prompts.slice(1)).toEqual([
      'Prompt five: here is the log [pasted text] what broke?',
      'Prompt four: keep the layout compact',
      'Prompt three: wire the toggle to the store',
      'Prompt two: add a dark mode toggle',
    ]);
    expect(s?.lastPrompt).toMatch(/^Prompt six: this screenshot/);
  });

  it('takes cwd, branch and version from the newest record', async () => {
    const s = (await read())[ID.busy];
    expect(s).toMatchObject({ gitBranch: 'feature-dark', updatedAt: NOW - 60_000, transcriptPath: transcript('-work-demo', ID.busy) });
  });

  it('skips a junk line and a line cut mid-write, and falls back to the last prompt for the title', async () => {
    const s = (await read())[ID.cut];
    expect(s).toMatchObject({ live: false, status: 'ended', cwd: '/work/other', gitBranch: 'develop', startedAt: Date.parse('2026-11-13T09:00:00.000Z') });
    expect(s?.recentPrompts).toEqual(['Second question: why does the build fail on CI when it passes locally', 'First real question about the parser']);
    expect(s?.title).toBe('Second question: why does the build fail on CI when it…');
  });

  it('finds sessions run inside a git worktree under their own project directory', async () => {
    const s = (await read({ resolveProjectKey: async (cwd) => cwd.replace(/\/\.claude\/worktrees\/.*$/, '') }))[ID.worktree];
    expect(s).toMatchObject({ cwd: '/work/demo/.claude/worktrees/feature-x', projectKey: '/work/demo', gitBranch: 'feature-x', name: 'feature-x-c3' });
  });

  it('uses cwd as the project key by default', async () => {
    expect((await read())[ID.worktree]?.projectKey).toBe('/work/demo/.claude/worktrees/feature-x');
  });

  it('reads only a bounded head and tail of a big transcript', async () => {
    const id = 'abababab-abab-4bab-8bab-abababababab';
    const path = join(dir, 'projects', '-work-big', `${id}.jsonl`);
    mkdirSync(join(dir, 'projects', '-work-big'));
    const filler = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(8000), tool_use_id: 't' }] }, toolUseResult: {}, cwd: '/work/big' })}\n`;
    writeFileSync(path, `${JSON.stringify({ type: 'custom-title', customTitle: 'Big one', sessionId: id })}\n${humanLine(id, 'The very first prompt')}`);
    appendFileSync(path, filler.repeat(700)); // ~5.6 MB: beyond the largest tail step
    appendFileSync(path, humanLine(id, 'Recent prompt A') + filler + humanLine(id, 'Recent prompt B'));
    expect(statSync(path).size).toBeGreaterThan(5 * 1024 * 1024);
    const s = (await read())[id];
    expect(s?.title).toBe('Big one');
    // The first prompt is in the head, but a gap separates it from the tail: it is not "recent".
    expect(s?.recentPrompts).toEqual(['Recent prompt B', 'Recent prompt A']);
    expect(s?.startedAt).toBe(Date.parse('2026-11-13T09:00:00.000Z'));
  });

  it('falls back to the last prompt when the tail read holds no prompt', async () => {
    const id = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
    const path = join(dir, 'projects', '-work-big', `${id}.jsonl`);
    mkdirSync(join(dir, 'projects', '-work-big'));
    const filler = `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'y'.repeat(8000), tool_use_id: 't' }] }, toolUseResult: {}, cwd: '/work/big' })}\n`;
    writeFileSync(path, humanLine(id, 'Port the importer to the new schema'));
    appendFileSync(path, filler.repeat(700));
    appendFileSync(path, `${JSON.stringify({ type: 'last-prompt', lastPrompt: 'Port the importer to the new schema', sessionId: id })}\n`);
    expect((await read())[id]?.recentPrompts).toEqual(['Port the importer to the new schema']);
  });

  it('gives a session with no cwd the folder its project directory is named after, when another session shows it', async () => {
    const lone = 'efefefef-efef-4fef-8fef-efefefefefef';
    const sibling = 'abcdabcd-abcd-4bcd-8bcd-abcdabcdabcd';
    const wandered = 'bcdebcde-bcde-4cde-8cde-bcdebcdebcde';
    writeFileSync(transcript('-work-demo', sibling), `${JSON.stringify({ type: 'custom-title', customTitle: 'Notes only', sessionId: sibling })}\n`);
    mkdirSync(join(dir, 'projects', '-work-nowhere'));
    writeFileSync(join(dir, 'projects', '-work-nowhere', `${lone}.jsonl`), `${JSON.stringify({ type: 'ai-title', aiTitle: 'Metadata only', sessionId: lone })}\n`);
    // A neighbour that moved elsewhere with `cd` does not say where the directory's sessions started.
    writeFileSync(join(dir, 'projects', '-work-nowhere', `${wandered}.jsonl`), humanLine(wandered, 'Look in the sibling folder').replace('/work/big', '/work/nowhere-else'));
    const asked: string[] = [];
    const s = await read({ resolveProjectKey: async (cwd) => (asked.push(cwd), `${cwd}-root`) });
    expect(s[sibling]).toMatchObject({ cwd: '', projectKey: '/work/demo-root' });
    expect(s[wandered]?.projectKey).toBe('/work/nowhere-else-root');
    expect(s[lone]).toMatchObject({ cwd: '', projectKey: NO_FOLDER_KEY });
    expect(asked).not.toContain('');
  });

  it('reads only what was appended, including a line that was incomplete on the previous read', async () => {
    const path = transcript('-work-demo', ID.waiting);
    const first = await read();
    expect(first[ID.waiting]?.recentPrompts).toEqual(['Run the migration on staging']);
    const next = humanLine(ID.waiting, 'Now do production');
    appendFileSync(path, humanLine(ID.waiting, 'Check the row counts') + next.slice(0, 40));
    expect((await read())[ID.waiting]?.recentPrompts).toEqual(['Check the row counts', 'Run the migration on staging']);
    appendFileSync(path, `${next.slice(40)}${JSON.stringify({ type: 'ai-title', aiTitle: 'Staging and production migration', sessionId: ID.waiting })}\n`);
    const third = (await read())[ID.waiting];
    expect(third?.recentPrompts).toEqual(['Now do production', 'Check the row counts', 'Run the migration on staging']);
    expect(third?.title).toBe('Staging and production migration');
  });

  it("reads the session's last answer as its report, skipping tool calls, subagents and API errors", async () => {
    const path = transcript('-work-demo', ID.waiting);
    const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', model: 'claude-x', content }, sessionId: ID.waiting, ...extra })}\n`;
    appendFileSync(
      path,
      assistant([{ type: 'text', text: 'An early note' }]) +
        assistant([{ type: 'text', text: '## Report\n\nDone.' }, { type: 'text', text: 'Still open:\n- a token' }]) +
        assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo "type":"text"' } }]) +
        assistant([{ type: 'text', text: 'From a subagent' }], { isSidechain: true }) +
        assistant([{ type: 'text', text: 'API Error: overloaded' }], { isApiErrorMessage: true }),
    );
    expect((await read())[ID.waiting]?.report).toBe('## Report\n\nDone.\n\nStill open:\n- a token');
    // A newer answer, appended, replaces it.
    appendFileSync(path, assistant([{ type: 'text', text: 'Newer answer' }]));
    expect((await read())[ID.waiting]?.report).toBe('Newer answer');
    expect((await read())[ID.busy]?.report).toBe('Working on it.');
  });

  it('caches a transcript by size and modification time', async () => {
    const path = transcript('-work-demo', ID.waiting);
    await read();
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replace('Run the migration on staging', 'Run the migration on stagixx'));
    setMtime(path, NOW - 60_000);
    expect((await read())[ID.waiting]?.recentPrompts).toEqual(['Run the migration on staging']);
    setMtime(path, NOW - 30_000);
    expect((await read())[ID.waiting]?.recentPrompts).toEqual(['Run the migration on stagixx']);
  });
});

describe('subagents and workflows', () => {
  it('reads finished, stopped and running subagents, skipping a broken meta file', async () => {
    const subs = (await read())[ID.busy]?.subagents ?? [];
    const byId = Object.fromEntries(subs.map((a) => [a.id, a]));
    expect(Object.keys(byId).sort()).toEqual(['aaaa000000000001', 'aaaa000000000002', 'aaaa000000000004', 'bbbb000000000001', 'bbbb000000000002', 'cccc000000000001']);
    expect(byId.aaaa000000000001).toMatchObject({ description: 'Survey the settings code', agentType: 'general-purpose', model: 'opus', finished: true, updatedAt: NOW - 60_000 });
    expect(byId.aaaa000000000002).toMatchObject({ agentType: 'Explore', finished: false });
    expect(byId.aaaa000000000002?.workflowRunId).toBeUndefined();
    expect(byId.aaaa000000000004).toMatchObject({ description: 'Draft the copy', finished: true });
    // Workflow agents: finished once the journal has their result, or once their run has ended.
    expect(byId.bbbb000000000001).toMatchObject({ workflowRunId: 'wf_0000run-aaa', finished: true });
    expect(byId.bbbb000000000002).toMatchObject({ workflowRunId: 'wf_0000run-aaa', finished: false });
    expect(byId.cccc000000000001).toMatchObject({ workflowRunId: 'wf_0000run-bbb', finished: true });
    // Running first.
    expect(subs.slice(0, 2).every((a) => !a.finished)).toBe(true);
  });

  it('reports a workflow with no run file yet as running, with its phases from the script and journal', async () => {
    const [running, completed] = (await read())[ID.busy]?.workflows ?? [];
    expect(running).toEqual({
      runId: 'wf_0000run-aaa',
      name: 'dark-mode-build',
      summary: 'Design, build and review dark mode',
      status: 'running',
      phases: [
        { title: 'Design', detail: 'tokens and contrast', state: 'done' },
        { title: 'Build', detail: 'the toggle and the store', state: 'current' },
        { title: 'Review', detail: undefined, state: 'pending' },
      ],
      agentCount: 2,
      startedAt: expect.any(Number),
    });
    expect(completed).toEqual({
      runId: 'wf_0000run-bbb',
      name: 'settings-audit',
      summary: 'Audit the settings code',
      status: 'completed',
      phases: [
        { title: 'Audit', detail: 'read everything', state: 'done' },
        { title: 'Report', detail: undefined, state: 'done' },
      ],
      agentCount: 1,
      startedAt: 1794480000000,
      durationMs: 600000,
    });
  });

  it('maps a killed run to failed, with the phase it stopped in as current', async () => {
    const [run] = (await read())[ID.stale]?.workflows ?? [];
    expect(run).toMatchObject({ runId: 'wf_0000run-ccc', status: 'failed', name: 'branch-cleanup' });
    expect(run?.phases.map((p) => p.state)).toEqual(['done', 'current', 'pending']);
  });

  it('reports a run left without a run file by a dead process as unknown, its agents finished', async () => {
    const s = (await read())[ID.other];
    expect(s?.title).toBe('Importer port');
    expect(s?.workflows).toEqual([expect.objectContaining({ runId: 'wf_0000run-ddd', status: 'unknown', name: 'importer-port', phases: [{ title: 'Port', detail: undefined }] })]);
    expect(s?.subagents).toEqual([expect.objectContaining({ id: 'eeee000000000001', workflowRunId: 'wf_0000run-ddd', finished: true })]);
  });

  it('marks finished a subagent left behind by an earlier process of a resumed session', async () => {
    const agent = join(dir, 'projects', '-work-demo', ID.busy, 'subagents', 'agent-aaaa000000000002.jsonl');
    setMtime(agent, STARTED - 86_400_000); // last written before the live process started
    const sub = (await read())[ID.busy]?.subagents.find((a) => a.id === 'aaaa000000000002');
    expect(sub).toMatchObject({ finished: true });
  });

  it('does not report as running a run from an earlier process of a resumed session', async () => {
    const runDir = join(dir, 'projects', '-work-demo', ID.busy, 'subagents', 'workflows', 'wf_0000run-aaa');
    setAllMtimes(runDir, 1794400000000); // before the live process started (1794500000000)
    const run = (await read())[ID.busy]?.workflows.find((w) => w.runId === 'wf_0000run-aaa');
    expect(run?.status).toBe('unknown');
  });
});

describe('window and tolerance', () => {
  it('leaves out ended sessions older than the window, never live ones', async () => {
    expect((await read())[ID.old]).toBeUndefined();
    expect((await read({ endedSessionDays: 30 }))[ID.old]).toMatchObject({ status: 'ended', title: 'Old question' });
    setMtime(transcript('-work-demo', ID.busy), NOW - 30 * 86_400_000);
    expect((await read())[ID.busy]?.live).toBe(true);
  });

  it('returns exactly the expected sessions: no empty transcripts, junk files or broken pid files', async () => {
    expect(Object.keys(await read()).sort()).toEqual([ID.busy, ID.waiting, ID.worktree, ID.stale, ID.cut, ID.nofile, ID.other].sort());
  });

  it('returns no sessions when the directory does not exist', async () => {
    expect(await readClaude(opts({ claudeDir: join(dir, 'missing') }))).toEqual([]);
  });

  it('keeps the other sessions when one session directory is unreadable', async () => {
    writeFileSync(join(dir, 'projects', '-work-demo', ID.waiting), 'a file where a directory is expected');
    const s = await read();
    expect(s[ID.waiting]).toMatchObject({ status: 'waiting', subagents: [], workflows: [] });
    expect(s[ID.busy]?.subagents.length).toBe(6);
  });
});

describe('pure parsers', () => {
  it('cleanPrompt drops command wrappers and machine text', () => {
    expect(cleanPrompt('<command-name>/model</command-name>', true)).toBeUndefined();
    expect(cleanPrompt('<local-command-stdout>ok</local-command-stdout>', false)).toBeUndefined();
    expect(cleanPrompt('[Request interrupted by user]', false)).toBeUndefined();
    expect(cleanPrompt('/compact', false)).toBeUndefined();
    expect(cleanPrompt('<system-reminder>x</system-reminder>', true)).toBeUndefined();
    expect(cleanPrompt('  fix   the\nbug  ', true)).toBe('fix the bug');
  });

  it('parseScriptMeta reads the meta object and ignores later objects', () => {
    expect(parseScriptMeta("export const meta = {\n  phases: [{ title: 'A' }],\n  name: 'n',\n}\nconst x = { name: 'other', description: 'no' }\n")).toEqual({
      name: 'n',
      description: undefined,
      phases: [{ title: 'A', detail: undefined }],
    });
    expect(parseScriptMeta('export default 1')).toEqual({ phases: [] });
  });
});
