import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose';
import { cleanCandidates, isHttpsUrl, isSessionId, knownFolders, knownUrls, parseMessage } from '../src/guards';
import type { ClaudeSession, WorkItem } from '../src/model';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ancestorsOf, parseLstart, parseProcessStarts, parsePsTable, readProcessStarts } from '../src/procs';
import { WindowRegistry } from '../src/windows';

const REPO = '/work/shop';
const WT = `${REPO}/.claude/worktrees`;

const session = (id: string, extra: Partial<ClaudeSession> = {}): ClaudeSession => ({
  sessionId: id,
  live: false,
  status: 'ended',
  title: id,
  cwd: REPO,
  projectKey: REPO,
  recentPrompts: [],
  subagents: [],
  workflows: [],
  ...extra,
});

const item = (branch: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  branch,
  isDefault: false,
  isCurrent: false,
  group: 'merged',
  dirtyCount: 0,
  ahead: 0,
  behind: 0,
  pushed: true,
  sessionIds: [],
  ...extra,
});

describe('parseMessage', () => {
  it('accepts the contract messages and nothing else', () => {
    expect(parseMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseMessage({ type: 'cleanMerged', extra: 1 })).toEqual({ type: 'cleanMerged' });
    expect(parseMessage({ type: 'resumeSession', sessionId: 'abc' })).toEqual({ type: 'resumeSession', sessionId: 'abc' });
    expect(parseMessage({ type: 'openFolder', path: '/x', newWindow: 'yes' })).toEqual({ type: 'openFolder', path: '/x', newWindow: false });
    expect(parseMessage({ type: 'copy', text: '' })).toEqual({ type: 'copy', text: '' });
    for (const bad of [null, 'ready', [], { type: 'runShell', cmd: 'ls' }, { type: 'resumeSession' }, { type: 'resumeSession', sessionId: 5 }, { type: 'openUrl' }]) {
      expect(parseMessage(bad)).toBeUndefined();
    }
  });
});

describe('isSessionId', () => {
  it('takes UUIDs, refuses anything a shell would read', () => {
    expect(isSessionId('1230fc2e-0000-4000-8000-000000000000')).toBe(true);
    for (const bad of ['', 'abc', '1234567; rm -rf ~', '$(whoami)-12345', '-dangerous-flag', 'a b c d e f g h']) expect(isSessionId(bad)).toBe(false);
  });
});

describe('isHttpsUrl', () => {
  it('only https', () => {
    expect(isHttpsUrl('https://github.com/acme/shop/pull/1')).toBe(true);
    for (const bad of ['http://github.com', 'file:///etc/passwd', 'javascript:alert(1)', 'command:workbench.action.reloadWindow', 'vscode://x', 'not a url']) {
      expect(isHttpsUrl(bad)).toBe(false);
    }
  });
});

describe('knownFolders', () => {
  it('worktrees, project roots and session folders from the State', () => {
    const state = compose({
      now: 0,
      workspaceProjectKey: REPO,
      sessions: [session('a', { cwd: `${REPO}/core` }), session('b', { cwd: '/other', projectKey: '/other' })],
      git: { available: true, repoRoot: REPO, defaultBranch: 'main', items: [item('main', { isDefault: true, worktreePath: REPO }), item('x', { worktreePath: `${WT}/x` })] },
    });
    const folders = knownFolders(state);
    expect([...folders].sort()).toEqual(['/other', REPO, `${WT}/x`, `${REPO}/core`].sort());
    expect(folders.has('/etc')).toBe(false);
  });

  it('never a relative path, such as the key of a session whose folder is unknown', () => {
    const state = compose({ now: 0, sessions: [session('a', { cwd: '', projectKey: '(unknown folder)' })] });
    expect([...knownFolders(state)]).toEqual([]);
  });
});

describe('knownUrls', () => {
  it('the https links the State shows, nothing else', () => {
    const prUrl = 'https://github.com/acme/shop/pull/7';
    const checks = 'https://github.com/acme/shop/actions/runs/70/job/1';
    const runUrl = 'https://github.com/acme/shop/actions/runs/71';
    const state = compose({
      now: 0,
      sessions: [],
      git: { available: true, repoRoot: REPO, defaultBranch: 'main', items: [item('main', { isDefault: true, group: 'active', worktreePath: REPO }), item('x', { group: 'active', ahead: 1 })] },
      github: {
        prs: [{ number: 7, title: 'X', url: prUrl, branch: 'x', isDraft: false, state: 'open', checks: { state: 'failure', url: checks }, updatedAt: 1 }],
        ciRuns: [{ id: 71, title: 't', workflow: 'CI', branch: 'main', status: 'failure', url: runUrl, startedAt: 2 }, { id: 72, title: 't', workflow: 'CI', branch: 'main', status: 'success', url: 'http://plain.example/run' }],
      },
    });
    const urls = knownUrls(state);
    expect([...urls].sort()).toEqual([checks, prUrl, runUrl].sort());
    expect(urls.has('https://attacker.example/x')).toBe(false);
  });
});

describe('cleanCandidates', () => {
  const build = (items: WorkItem[], sessions: ClaudeSession[] = []) =>
    compose({ now: 0, workspaceProjectKey: REPO, sessions, git: { available: true, repoRoot: REPO, defaultBranch: 'main', items } });

  it('merged, clean, not the default, not checked out here, no live Claude', () => {
    const state = build(
      [
        item('main', { isDefault: true, group: 'active', worktreePath: REPO }),
        item('done', { worktreePath: `${WT}/done` }),
        item('done-no-worktree'),
        item('ended-claude', { worktreePath: `${WT}/ended-claude` }),
        item('live-claude', { worktreePath: `${WT}/live-claude` }),
        item('open-here', { worktreePath: `${WT}/open-here` }),
        item('current', { isCurrent: true, worktreePath: `${WT}/current` }),
        item('active', { group: 'active', ahead: 1, worktreePath: `${WT}/active` }),
        item('stale', { group: 'stale', ahead: 1 }),
        item('dirty', { dirtyCount: 1, worktreePath: `${WT}/dirty` }),
        item('squash-merged', { ahead: 2, worktreePath: `${WT}/squash-merged` }),
        item('worktree-agent-a1', { worktreePath: `${WT}/agent-a1` }),
        item('other-window', { worktreePath: `${WT}/other-window` }),
        item('-x'),
      ],
      [
        session('e', { cwd: `${WT}/ended-claude` }),
        session('l', { cwd: `${WT}/live-claude/app`, live: true, status: 'busy' }),
        // Its cwd is the main checkout; its running subagent works in agent-a1.
        session('m', { live: true, status: 'busy', subagents: [{ id: 'a1', description: 'Explore', agentType: 'Explore', finished: false }] }),
      ],
    );
    const names = cleanCandidates(state, [`${WT}/open-here`, `${WT}/other-window`]).map((i) => i.branch);
    expect(names.sort()).toEqual(['done', 'done-no-worktree', 'ended-claude']);
  });

  it('never the main checkout, whatever its branch', () => {
    const state = build([item('main', { isDefault: true, group: 'active' }), item('feature', { worktreePath: REPO })]);
    expect(cleanCandidates(state, [])).toEqual([]);
  });
});

describe('process tree', () => {
  const table = parsePsTable('    1     0\n  400     1\n  410   400\n  420   410\n  bad line\n  500   500\n');

  it('parses ps output', () => {
    expect(table.get(420)).toBe(410);
    expect(table.size).toBe(5);
  });

  it('walks ancestors nearest first, stopping at init and at loops', () => {
    expect(ancestorsOf(420, table)).toEqual([410, 400]);
    expect(ancestorsOf(500, table)).toEqual([]);
    expect(ancestorsOf(999, table)).toEqual([]);
  });

  it('reads start times as ps prints them under TZ=UTC0, and as procStart is written', () => {
    expect(parseLstart('Fri Nov 13 04:50:01 2026')).toBe(Date.UTC(2026, 10, 13, 4, 50, 1));
    expect(parseLstart('Thu Jan  1 00:00:12 1970')).toBe(12_000);
    for (const bad of ['', 'yesterday', 'Fri Foo 13 04:50:01 2026', '2026-11-13T04:50:01Z']) expect(parseLstart(bad)).toBeUndefined();
    const starts = parseProcessStarts('61148 Fri Nov 13 23:44:49 2026    \n 4378 Fri Nov  3 04:50:01 2026\njunk\n');
    expect([...starts]).toEqual([
      [61148, Date.UTC(2026, 10, 13, 23, 44, 49)],
      [4378, Date.UTC(2026, 10, 3, 4, 50, 1)],
    ]);
  });

  it('asks ps for the start of this process, and gets nothing for a pid with no process', async () => {
    const starts = await readProcessStarts([process.pid, 99_998]);
    const own = starts?.get(process.pid);
    expect(own).toBeGreaterThan(Date.now() - 3_600_000);
    expect(own).toBeLessThanOrEqual(Date.now());
    expect(starts?.has(99_998)).toBe(false);
    expect(await readProcessStarts([99_998])).toEqual(new Map());
  });
});

describe('WindowRegistry', () => {
  it('lists the folders of the other live windows, and forgets windows that are gone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-windows-'));
    try {
      const alive = new Set([1, 2]);
      const me = new WindowRegistry(dir, 1, (p) => alive.has(p));
      const other = new WindowRegistry(dir, 2, (p) => alive.has(p));
      const crashed = new WindowRegistry(dir, 3, (p) => alive.has(p));
      me.publish([`${WT}/mine`]);
      other.publish([`${WT}/theirs`]);
      crashed.publish([`${WT}/crashed`]);
      writeFileSync(join(dir, '4.json'), '{ half-written');
      alive.add(4);
      expect(me.otherFolders()).toEqual([`${WT}/theirs`]);
      other.dispose();
      expect(me.otherFolders()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
