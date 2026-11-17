import { describe, expect, it } from 'vitest';
import { parseArgs, parseRequest, statusLines, USAGE } from '../src/agent';
import { parseRoadmap } from '../src/data/roadmap';
import { type ClaudeSession, emptyState, type State, type WorkItem } from '../src/model';

describe('parseArgs', () => {
  const ok = (argv: string[], branch?: string) => {
    const r = parseArgs(argv, branch);
    if (!r.ok) throw new Error(r.error);
    return r.action;
  };
  const error = (argv: string[], branch?: string) => {
    const r = parseArgs(argv, branch);
    if (r.ok) throw new Error(`parsed: ${JSON.stringify(r.action)}`);
    return r.error;
  };

  it('reads each command', () => {
    expect(ok(['status'])).toEqual({ verb: 'status' });
    expect(ok(['status'], 'worktree-x')).toEqual({ verb: 'status', branch: 'worktree-x' });
    expect(ok(['ship'], 'worktree-x')).toEqual({ verb: 'ship', branch: 'worktree-x' });
    expect(ok(['ship', 'feature/y'], 'worktree-x')).toEqual({ verb: 'ship', branch: 'feature/y' });
    expect(ok(['release', '0.3.0'])).toEqual({ verb: 'release', version: '0.3.0' });
    expect(ok(['tag', '1.0.0-rc.1'])).toEqual({ verb: 'tag', version: '1.0.0-rc.1' });
    expect(ok(['pull'])).toEqual({ verb: 'pull' });
    expect(ok(['add', 'Backlog', 'Dark', ' mode\n for  the board'])).toEqual({ verb: 'add', lane: 'Backlog', text: 'Dark mode for the board' });
    expect(ok(['lane', '0.4.0'])).toEqual({ verb: 'lane', version: '0.4.0' });
    expect(ok(['lane', '0.4.0', 'Search', 'and', 'export'])).toEqual({ verb: 'lane', version: '0.4.0', title: 'Search and export' });
  });

  it('says what is wrong', () => {
    expect(error([])).toBe(USAGE);
    expect(error(['deploy'])).toContain('"deploy" is not a cockpit command');
    expect(error(['status', 'now'])).toContain('takes no arguments');
    expect(error(['ship'])).toContain('Not on a branch');
    expect(error(['ship', 'a', 'b'])).toContain('one branch');
    expect(error(['ship', '--force'])).toContain('not a branch name');
    expect(error(['ship', 'a..b'])).toContain('not a branch name');
    expect(error(['release'])).toContain('needs a version');
    expect(error(['release', 'v1.2'])).toContain('not a version');
    expect(error(['tag', '1.2.0', 'extra'])).toContain('one version');
    expect(error(['add', 'Backlog'])).toContain('needs a lane');
    expect(error(['add', 'Backlog', 'x'.repeat(1001)])).toContain('longer than 1000');
    expect(error(['lane', 'Backlog'])).toContain('not a version');
  });

  it('leaves out a current branch it would not take', () => {
    expect(ok(['status'], '-x')).toEqual({ verb: 'status' });
  });
});

describe('parseRequest', () => {
  const req = (v: unknown) => parseRequest(JSON.stringify(v));

  it('takes what the command sends', () => {
    for (const a of [
      { verb: 'status' },
      { verb: 'status', branch: 'worktree-x' },
      { verb: 'ship', branch: 'worktree-x' },
      { verb: 'release', version: '1.2.0' },
      { verb: 'tag', version: '1.2.0' },
      { verb: 'pull' },
      { verb: 'add', lane: 'Backlog', text: 'Dark mode' },
      { verb: 'lane', version: '1.2.0' },
      { verb: 'lane', version: '1.2.0', title: 'Search' },
    ]) {
      expect(req(a)).toEqual(a);
    }
  });

  it('refuses anything else, and drops unknown fields', () => {
    expect(parseRequest('not json')).toBeUndefined();
    expect(req(null)).toBeUndefined();
    expect(req(['ship'])).toBeUndefined();
    expect(req({ verb: 'rm' })).toBeUndefined();
    expect(req({ verb: 'ship' })).toBeUndefined();
    expect(req({ verb: 'ship', branch: '--delete' })).toBeUndefined();
    expect(req({ verb: 'status', branch: 3 })).toBeUndefined();
    expect(req({ verb: 'release', version: '1.2.0; rm -rf ~' })).toBeUndefined();
    expect(req({ verb: 'add', lane: 'Backlog', text: 'two\nlines' })).toBeUndefined();
    expect(req({ verb: 'add', lane: 'Backlog', text: 'x'.repeat(1001) })).toBeUndefined();
    expect(req({ verb: 'add', lane: '', text: 'x' })).toBeUndefined();
    expect(req({ verb: 'lane', version: '1.2.0', title: 7 })).toBeUndefined();
    expect(req({ verb: 'pull', extra: 'x' })).toEqual({ verb: 'pull' });
  });
});

const ROOT = '/work/app';

const item = (branch: string, extra: Partial<WorkItem> = {}): WorkItem => ({
  branch,
  isDefault: false,
  isCurrent: false,
  group: 'active',
  dirtyCount: 0,
  ahead: 0,
  behind: 0,
  pushed: false,
  sessionIds: [],
  ...extra,
});

const busy = (id: string): ClaudeSession => ({
  sessionId: id,
  live: true,
  status: 'busy',
  title: id,
  cwd: `${ROOT}/.claude/worktrees/${id}`,
  projectKey: ROOT,
  recentPrompts: [],
  subagents: [],
  workflows: [],
});

const ROADMAP = `## 0.2.0
Status: shipped

- [x] Old

## 0.3.0 - The cockpit command

- [x] Status <!-- cockpit:worktree-status -->
- [x] Ship

## 0.4.0

- [x] Search
- [~] Export <!-- cockpit:worktree-export -->

## Backlog

- [ ] Dark mode
`;

function state(work: Partial<State['work']>, extra: Partial<State> = {}): State {
  const base = emptyState();
  return {
    ...base,
    workspace: { name: 'app', path: ROOT },
    work: { ...base.work, available: true, repoRoot: ROOT, defaultBranch: 'main', items: [item('main', { isDefault: true, worktreePath: ROOT })], ...work },
    releases: { ...base.releases, available: true, latestTag: 'v0.2.0', roadmapExists: true, roadmapName: '.cockpit/roadmap.md', roadmapPath: `${ROOT}/.cockpit/roadmap.md`, roadmap: parseRoadmap(ROADMAP) },
    ...extra,
  };
}

describe('statusLines', () => {
  it('shows the delivery, the board and what to release, in direct delivery', () => {
    const lines = statusLines(state({ delivery: 'direct', hasOrigin: false }));
    const text = lines.join('\n');
    expect(lines[0]).toBe('Cockpit: app');
    expect(text).toContain('Delivery: direct: ship merges into main here; release commits and tags on main.');
    expect(text).toContain('Board: .cockpit/roadmap.md');
    // A shipped and tagged lane takes one line.
    expect(lines).toContain('0.2.0  shipped');
    expect(text).not.toContain('[x] Old');
    expect(text).toContain('0.3.0 · The cockpit command  2 of 2 done');
    expect(text).toContain('  [x] Status  <worktree-status>');
    expect(text).toContain('  next: cockpit release 0.3.0  (commits Release 0.3.0 on main and tags v0.3.0)');
    expect(text).toContain('0.4.0  1 of 2 done');
    expect(text).toContain('  [~] Export  <worktree-export>');
    expect(text).toContain('  next: 1 card to finish before it can be released');
    expect(text).toContain('Backlog\n  [ ] Dark mode');
    expect(lines.at(-1)).toBe('Next: cockpit release 0.3.0');
  });

  it('says when the direct delivery pushes', () => {
    expect(statusLines(state({ delivery: 'direct', hasOrigin: true })).join('\n')).toContain('ship merges into main here and pushes it;');
  });

  it('lists branches with whether they can ship, the asking Claude not counting as busy on its own', () => {
    const s = state(
      {
        delivery: 'pr',
        hasOrigin: true,
        github: 'o/r',
        items: [
          item('main', { isDefault: true, worktreePath: ROOT }),
          item('worktree-status', { worktreePath: `${ROOT}/.claude/worktrees/status`, ahead: 2, sessionIds: ['me'] }),
          item('worktree-export', { worktreePath: `${ROOT}/.claude/worktrees/export`, ahead: 1, sessionIds: ['other'] }),
          item('worktree-dirty', { worktreePath: `${ROOT}/.claude/worktrees/dirty`, ahead: 1, dirtyCount: 3 }),
          item('worktree-done', { worktreePath: `${ROOT}/.claude/worktrees/done` }),
        ],
      },
      { sessions: { me: busy('me'), other: busy('other') } },
    );
    const lines = statusLines(s, 'worktree-status');
    const text = lines.join('\n');
    expect(text).toContain('Delivery: pull requests on o/r: ship pushes the branch and opens its pull request.');
    expect(text).toContain('  next: cockpit release 0.3.0  (opens the release pull request)');
    expect(text).toContain('Branches\n  worktree-status (here)  2 ahead\n    ready to ship: cockpit ship');
    expect(text).toContain('  worktree-export  1 ahead\n    cannot ship: An agent is still working on worktree-export.');
    expect(text).toContain('  worktree-dirty  1 ahead, 3 uncommitted\n    cannot ship:');
    expect(text).not.toContain('worktree-done');
    // The asking Claude's own branch comes before the release.
    expect(lines.at(-1)).toBe('Next: cockpit ship');
  });

  it('points at the open release pull request, the tag and the pull', () => {
    const pr = { number: 7, title: 'Release 0.3.0', url: 'https://github.com/o/r/pull/7', branch: 'release-0.3.0', isDraft: false, state: 'open' as const, checks: { state: 'success' as const } };
    const review = state({ delivery: 'pr', github: 'o/r', items: [item('main', { isDefault: true, worktreePath: ROOT }), item('release-0.3.0', { pr })] });
    expect(statusLines(review).join('\n')).toContain('next: release pull request #7 is open, merge it on GitHub (https://github.com/o/r/pull/7)');

    const merged = state({ delivery: 'pr', github: 'o/r', items: [item('main', { isDefault: true, worktreePath: ROOT }), item('release-0.3.0', { pr: { ...pr, state: 'merged' } })] });
    merged.releases.roadmap = merged.releases.roadmap.map((l) => (l.version === '0.3.0' ? { ...l, status: 'shipped', merged: true } : l));
    const lines = statusLines(merged);
    expect(lines.join('\n')).toContain('  next: cockpit tag 0.3.0');
    expect(lines.at(-1)).toBe('Next: cockpit tag 0.3.0');
    expect(lines.join('\n')).not.toContain('Next: cockpit pull');
  });

  it('says how to start a board when there is none', () => {
    const s = state({ delivery: 'direct' });
    s.releases = { ...s.releases, roadmapExists: false, roadmap: [] };
    const lines = statusLines(s);
    expect(lines).toContain('Board: none yet (.cockpit/roadmap.md): cockpit add Backlog <text> or cockpit lane <version> starts it.');
    expect(lines.at(-1)).toBe('Next: nothing to ship or release right now.');
  });
});
