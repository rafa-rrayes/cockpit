import { describe, expect, it } from 'vitest';
import { buildActivity, buildAttention, buildItems, buildProjects, compose, itemForSession, type GitResult, type GithubResult } from '../src/compose';
import type { CiRun, ClaudeSession, PullRequest, WorkItem } from '../src/model';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const REPO = '/work/shop';

const session = (id: string, extra: Partial<ClaudeSession> = {}): ClaudeSession => ({
  sessionId: id,
  live: false,
  status: 'ended',
  title: `Title ${id}`,
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
  group: 'active',
  dirtyCount: 0,
  ahead: 0,
  behind: 0,
  pushed: true,
  sessionIds: [],
  ...extra,
});

const pr = (n: number, branch: string, extra: Partial<PullRequest> = {}): PullRequest => ({
  number: n,
  title: `PR ${n}`,
  url: `https://github.com/acme/shop/pull/${n}`,
  branch,
  isDraft: false,
  state: 'open',
  checks: { state: 'none' },
  ...extra,
});

const run = (id: number, extra: Partial<CiRun> = {}): CiRun => ({
  id,
  title: `run ${id}`,
  workflow: 'CI',
  branch: 'main',
  status: 'success',
  url: `https://github.com/acme/shop/actions/runs/${id}`,
  ...extra,
});

// The main checkout on main, with agent worktrees inside it (as Claude Code creates them) and one beside it.
const items = (): WorkItem[] => [
  item('main', { isDefault: true, isCurrent: true, worktreePath: REPO }),
  item('feature-x', { worktreePath: `${REPO}/.claude/worktrees/feature-x`, ahead: 2 }),
  item('feature-x-2', { worktreePath: `${REPO}/.claude/worktrees/feature-x-2`, ahead: 1 }),
  item('sibling', { worktreePath: '/work/shop-sibling', ahead: 1 }),
  item('lost-worktree', { ahead: 1 }),
  item('old', { group: 'stale', ahead: 3, worktreePath: '/work/old', lastCommitAt: NOW - 30 * DAY }),
];
const git = (list = items()): GitResult => ({ available: true, repoRoot: REPO, defaultBranch: 'main', items: list });

describe('itemForSession', () => {
  const list = items();
  const find = (s: ClaudeSession) => itemForSession(s, list, REPO)?.branch;

  it('picks the deepest worktree containing the cwd, not the main checkout around it', () => {
    expect(find(session('a', { cwd: `${REPO}/.claude/worktrees/feature-x` }))).toBe('feature-x');
    expect(find(session('b', { cwd: `${REPO}/.claude/worktrees/feature-x/app/src` }))).toBe('feature-x');
    // A name that only starts like another worktree is not inside it.
    expect(find(session('c', { cwd: `${REPO}/.claude/worktrees/feature-x-2` }))).toBe('feature-x-2');
    expect(find(session('d', { cwd: '/work/shop-sibling', projectKey: REPO }))).toBe('sibling');
  });

  it('gives the main checkout to the branch checked out there', () => {
    expect(find(session('a', { cwd: `${REPO}/core` }))).toBe('main');
    expect(find(session('b', { cwd: REPO, gitBranch: 'main' }))).toBe('main');
  });

  it('a session of the project matching no worktree path goes to the main checkout', () => {
    expect(find(session('a', { cwd: '/symlinked/shop', projectKey: REPO }))).toBe('main');
    expect(find(session('b', { cwd: '/elsewhere', projectKey: '/elsewhere' }))).toBeUndefined();
  });

  it('a session whose worktree was removed by hand goes to its branch; one on a branch that is gone, nowhere', () => {
    expect(find(session('a', { cwd: `${REPO}/.claude/worktrees/lost-worktree`, gitBranch: 'lost-worktree' }))).toBe('lost-worktree');
    expect(find(session('b', { cwd: `${REPO}/.claude/worktrees/deleted`, gitBranch: 'deleted' }))).toBeUndefined();
    // A branch that has its own worktree elsewhere is not where a main-checkout session ran.
    expect(find(session('c', { cwd: REPO, gitBranch: 'feature-x' }))).toBeUndefined();
  });

  it('a session with no cwd belongs nowhere, even when its project is known', () => {
    expect(find(session('a', { cwd: '', projectKey: '' }))).toBeUndefined();
    expect(find(session('b', { cwd: '', projectKey: REPO }))).toBeUndefined();
  });

  it('a session in another repository nested in the main checkout is not the main checkout\'s', () => {
    expect(find(session('a', { cwd: `${REPO}/sites/landing`, projectKey: `${REPO}/sites/landing` }))).toBeUndefined();
    expect(find(session('b', { cwd: `${REPO}/sites/landing/src`, projectKey: `${REPO}/sites/landing`, live: true, status: 'busy' }))).toBeUndefined();
  });
});

describe('buildItems', () => {
  it('fills sessionIds live first, then newest', () => {
    const sessions = [
      session('old', { updatedAt: NOW - 3 * DAY }),
      session('new', { updatedAt: NOW - MIN }),
      session('live', { live: true, status: 'busy', updatedAt: NOW - DAY }),
    ];
    const main = buildItems(git(), sessions, []).find((i) => i.branch === 'main');
    expect(main?.sessionIds).toEqual(['live', 'new', 'old']);
  });

  it('a stale branch with a live session is active; with an ended one it stays stale', () => {
    const cwd = '/work/old';
    expect(buildItems(git(), [session('a', { cwd, live: true, status: 'idle' })], []).find((i) => i.branch === 'old')?.group).toBe('active');
    expect(buildItems(git(), [session('a', { cwd })], []).find((i) => i.branch === 'old')?.group).toBe('stale');
  });

  it('a clean branch with nothing ahead is merged, unless a Claude works there: then it is active', () => {
    const list = [item('main', { isDefault: true, worktreePath: REPO }), item('fresh', { group: 'merged', worktreePath: `${REPO}/.claude/worktrees/fresh` })];
    const cwd = `${REPO}/.claude/worktrees/fresh`;
    const group = (sessions: ClaudeSession[]) => buildItems(git(list), sessions, []).find((i) => i.branch === 'fresh')?.group;
    expect(group([session('a', { cwd })])).toBe('merged');
    expect(group([session('a', { cwd, live: true, status: 'busy' })])).toBe('active');
  });

  it('the worktree of a subagent still running in a live session is active, though the session sits in the main checkout', () => {
    const wt = `${REPO}/.claude/worktrees/agent-a0b1c2d3e4f5a6b7c`;
    const list = [item('main', { isDefault: true, worktreePath: REPO }), item('worktree-agent-a0b1c2d3e4f5a6b7c', { group: 'merged', worktreePath: wt })];
    const agent = { id: 'a0b1c2d3e4f5a6b7c', description: 'Explore', agentType: 'Explore', finished: false };
    const group = (s: ClaudeSession) => buildItems(git(list), [s], []).find((i) => i.worktreePath === wt)?.group;
    expect(group(session('a', { live: true, status: 'busy', subagents: [agent] }))).toBe('active');
    expect(group(session('a', { live: true, status: 'busy', subagents: [{ ...agent, finished: true }] }))).toBe('merged');
    expect(group(session('a', { subagents: [agent] }))).toBe('merged');
  });

  it('links the open PR before older ones, and never one for the default branch', () => {
    const prs = [pr(3, 'feature-x', { state: 'closed', updatedAt: NOW - MIN }), pr(2, 'feature-x', { updatedAt: NOW - DAY }), pr(1, 'main')];
    const out = buildItems(git(), [], prs);
    expect(out.find((i) => i.branch === 'feature-x')?.pr?.number).toBe(2);
    expect(out.find((i) => i.branch === 'main')?.pr).toBeUndefined();
  });

  it('a clean branch whose PR was merged after its last commit counts as merged (squash merge)', () => {
    const list = [
      item('main', { isDefault: true, worktreePath: REPO }),
      item('squashed', { ahead: 2, lastCommitAt: NOW - DAY }),
      item('dirty', { ahead: 2, dirtyCount: 1, lastCommitAt: NOW - DAY }),
      item('more-work', { ahead: 3, lastCommitAt: NOW - MIN }),
    ];
    const prs = [pr(1, 'squashed', { state: 'merged', updatedAt: NOW - DAY + MIN }), pr(2, 'dirty', { state: 'merged', updatedAt: NOW }), pr(3, 'more-work', { state: 'merged', updatedAt: NOW - DAY })];
    const groups = Object.fromEntries(buildItems(git(list), [], prs).map((i) => [i.branch, i.group]));
    expect(groups).toEqual({ main: 'active', squashed: 'merged', dirty: 'active', 'more-work': 'active' });
  });

  it('keeps the default branch first and sorts by group', () => {
    const out = buildItems(git(), [], []);
    expect(out[0]?.branch).toBe('main');
    expect(out.at(-1)?.group).toBe('stale');
  });
});

describe('buildProjects', () => {
  it('workspace first (even empty), then projects with live sessions, then by latest activity', () => {
    const sessions = [
      session('a', { projectKey: '/p/quiet', updatedAt: NOW - MIN }),
      session('b', { projectKey: '/p/live', live: true, status: 'idle', updatedAt: NOW - DAY }),
      session('c', { projectKey: '/p/older', updatedAt: NOW - 2 * DAY }),
    ];
    const projects = buildProjects(sessions, REPO);
    expect(projects.map((p) => [p.name, p.isWorkspace, p.sessionIds])).toEqual([
      ['shop', true, []],
      ['live', false, ['b']],
      ['quiet', false, ['a']],
      ['older', false, ['c']],
    ]);
  });

  it('orders sessions live first, then by updatedAt', () => {
    const sessions = [session('x', { updatedAt: NOW - DAY }), session('y', { updatedAt: NOW }), session('z', { live: true, status: 'busy', updatedAt: NOW - 3 * DAY })];
    expect(buildProjects(sessions, REPO)[0]?.sessionIds).toEqual(['z', 'y', 'x']);
  });
});

describe('buildAttention', () => {
  const projects = buildProjects([], REPO);

  it('lists waiting sessions with what they wait for', () => {
    const out = buildAttention([session('w', { live: true, status: 'waiting', waitingFor: 'permission prompt', updatedAt: NOW })], projects, undefined, 'main');
    expect(out).toEqual([{ kind: 'session_waiting', title: 'Title w', detail: 'Waiting: permission prompt · shop', sessionId: 'w', at: NOW }]);
  });

  it('CI: only when the newest run of a workflow on the default branch failed', () => {
    const github: GithubResult = {
      prs: [],
      ciRuns: [
        run(5, { status: 'success', startedAt: NOW }),
        run(4, { status: 'failure', startedAt: NOW - MIN }), // fixed by run 5
        run(3, { workflow: 'Deploy', status: 'failure', startedAt: NOW - 2 * MIN }),
        run(2, { branch: 'feature-x', status: 'failure', startedAt: NOW }),
      ],
    };
    const out = buildAttention([], projects, github, 'main');
    expect(out.map((a) => [a.kind, a.title, a.url])).toEqual([['ci_failed', 'Deploy failed on main', 'https://github.com/acme/shop/actions/runs/3']]);
  });

  it('open PRs with changes requested', () => {
    const github: GithubResult = {
      prs: [pr(7, 'a', { reviewDecision: 'changes_requested' }), pr(6, 'b', { reviewDecision: 'changes_requested', state: 'closed' }), pr(5, 'c', { reviewDecision: 'approved' })],
      ciRuns: [],
    };
    expect(buildAttention([], projects, github, 'main').map((a) => a.title)).toEqual(['#7 PR 7']);
  });
});

describe('buildActivity', () => {
  it('merges commits, session starts and ends, CI and PRs, newest first', () => {
    const sessions = [
      session('live', { live: true, status: 'busy', startedAt: NOW - 10 * MIN, updatedAt: NOW }),
      session('done', { startedAt: NOW - 60 * MIN, updatedAt: NOW - 30 * MIN, gitBranch: 'main' }),
    ];
    const github: GithubResult = { prs: [pr(9, 'feature-x', { isDraft: true, updatedAt: NOW - 5 * MIN })], ciRuns: [run(1, { status: 'failure', startedAt: NOW - 20 * MIN })] };
    const commits = [{ kind: 'commit' as const, at: NOW - 40 * MIN, title: 'Fix checkout', branch: 'main' }];
    const out = buildActivity(sessions, buildProjects(sessions, REPO), github, commits);
    expect(out.map((e) => [e.kind, e.title])).toEqual([
      ['pr', '#9 PR 9'],
      ['session_started', 'Title live'],
      ['ci', 'CI failed'],
      ['session_ended', 'Title done'],
      ['commit', 'Fix checkout'],
      ['session_started', 'Title done'],
    ]);
    expect(out[0]?.detail).toBe('draft');
  });

  it('keeps the newest 60', () => {
    const commits = Array.from({ length: 100 }, (_, i) => ({ kind: 'commit' as const, at: NOW - i * MIN, title: `c${i}` }));
    const out = buildActivity([], [], undefined, commits);
    expect(out).toHaveLength(60);
    expect(out[0]?.title).toBe('c0');
  });
});

describe('compose', () => {
  it('outside git: no work, sessions and projects still there', () => {
    const state = compose({ now: NOW, workspace: { name: 'notes', path: '/p/notes' }, workspaceProjectKey: '/p/notes', sessions: [session('a', { projectKey: '/p/notes' })] });
    expect(state.work).toEqual({ available: false, items: [], ciRuns: [] });
    expect(state.releases.available).toBe(false);
    expect(state.projects[0]).toMatchObject({ key: '/p/notes', isWorkspace: true, sessionIds: ['a'] });
    expect(Object.keys(state.sessions)).toEqual(['a']);
  });

  it('carries the repository facts and the GitHub note', () => {
    const state = compose({ now: NOW, sessions: [], git: git(), github: { githubNote: 'gh not logged in', prs: [], ciRuns: [] } });
    expect(state.work).toMatchObject({ available: true, repoRoot: REPO, defaultBranch: 'main', githubNote: 'gh not logged in' });
    expect(state.work.github).toBeUndefined();
    expect(state.generatedAt).toBe(NOW);
    expect(state.workspace).toBeUndefined();
  });

  it('is plain JSON', () => {
    const state = compose({ now: NOW, sessions: [session('a')], git: git(), github: { prs: [pr(1, 'feature-x')], ciRuns: [run(1, { startedAt: NOW })] } });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});
