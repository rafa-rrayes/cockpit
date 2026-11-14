import { describe, expect, it } from 'vitest';
import { compose } from '../src/compose';
import { cleanCandidates, isHttpsUrl, isSessionId, knownFolders, parseMessage } from '../src/guards';
import type { ClaudeSession, WorkItem } from '../src/model';
import { ancestorsOf, parsePsTable } from '../src/procs';

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
        item('-x'),
      ],
      [session('e', { cwd: `${WT}/ended-claude` }), session('l', { cwd: `${WT}/live-claude/app`, live: true, status: 'busy' })],
    );
    const names = cleanCandidates(state, [`${WT}/open-here`]).map((i) => i.branch);
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
});
