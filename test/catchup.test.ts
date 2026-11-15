import { describe, expect, it } from 'vitest';
import { canShip, catchUp, shipProblem, FIRST_LOOK_MS, laneOf, markOf, parseMark, stillOpen } from '../src/catchup';
import { parseRoadmap } from '../src/data/roadmap';
import { type ClaudeSession, emptyState, type PullRequest, type State, type WorkItem } from '../src/model';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const ROOT = '/work/app';

const session = (id: string, extra: Partial<ClaudeSession>): ClaudeSession => ({
  sessionId: id,
  live: false,
  status: 'ended',
  title: id,
  cwd: `${ROOT}/.claude/worktrees/${id}`,
  projectKey: ROOT,
  recentPrompts: [],
  subagents: [],
  workflows: [],
  ...extra,
});

const item = (branch: string, extra: Partial<WorkItem>): WorkItem => ({
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

const pr = (number: number, branch: string, extra: Partial<PullRequest>): PullRequest => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  branch,
  isDraft: false,
  state: 'open',
  checks: { state: 'pending' },
  updatedAt: NOW - 5 * MIN,
  ...extra,
});

const ROADMAP = `## 0.2.0

- [~] Ship it <!-- cockpit:worktree-0.2.0-ship-it -->
- [~] And this <!-- cockpit:worktree-0.2.0-ship-it -->
- [ ] Other

## Backlog
`;

function state(sessions: ClaudeSession[], items: WorkItem[], extra: Partial<State> = {}): State {
  const base = emptyState();
  return {
    ...base,
    generatedAt: NOW,
    sessions: Object.fromEntries(sessions.map((s) => [s.sessionId, s])),
    projects: [{ key: ROOT, name: 'app', isWorkspace: true, sessionIds: sessions.map((s) => s.sessionId) }],
    work: { available: true, repoRoot: ROOT, defaultBranch: 'main', github: 'o/r', items, ciRuns: [] },
    releases: { ...base.releases, roadmap: parseRoadmap(ROADMAP) },
    ...extra,
  };
}

const main = item('main', { isDefault: true, isCurrent: true, worktreePath: ROOT });

describe('catchUp', () => {
  it('shows finished sessions since the mark with their branch, cards and next action, newest first', () => {
    const done = session('done', { updatedAt: NOW - 10 * MIN, report: 'All done.' });
    const old = session('old', { updatedAt: NOW - 3 * 60 * MIN });
    const busy = session('busy', { live: true, status: 'busy', updatedAt: NOW - MIN });
    const s = state([done, old, busy], [main, item('worktree-0.2.0-ship-it', { worktreePath: `${ROOT}/.claude/worktrees/done`, ahead: 2, sessionIds: ['done'] })], {
      caughtUp: { at: NOW - 60 * MIN, prs: {} },
    });
    const entries = catchUp(s);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e).toMatchObject({ kind: 'session', at: NOW - 10 * MIN, action: 'ship' });
    if (e?.kind !== 'session') throw new Error('not a session entry');
    expect(e.session.report).toBe('All done.');
    expect(e.item?.branch).toBe('worktree-0.2.0-ship-it');
    expect(e.cards.map((c) => c.text)).toEqual(['Ship it', 'And this']);
  });

  it('counts the last day as new before the first catch up', () => {
    const recent = session('recent', { updatedAt: NOW - FIRST_LOOK_MS + MIN });
    const older = session('older', { updatedAt: NOW - FIRST_LOOK_MS - MIN });
    expect(catchUp(state([recent, older], [main])).map((e) => e.kind === 'session' && e.session.sessionId)).toEqual(['recent']);
  });

  it('picks the one next action: focus or open a waiting Claude, resume one that left changes, open its PR, ship, or open', () => {
    const at = NOW - MIN;
    const wt = (id: string) => `${ROOT}/.claude/worktrees/${id}`;
    const s = state(
      [
        session('waitingHere', { live: true, status: 'waiting', inVsCodeTerminal: true, updatedAt: at }),
        session('waitingElsewhere', { live: true, status: 'waiting', updatedAt: at }),
        session('dirty', { updatedAt: at }),
        session('dirtyIdle', { live: true, status: 'idle', updatedAt: at }),
        session('inReview', { updatedAt: at }),
        session('ready', { updatedAt: at }),
        session('nothing', { updatedAt: at }),
        session('mainline', { cwd: ROOT, updatedAt: at }),
      ],
      [
        { ...main, sessionIds: ['mainline'] },
        item('w', { worktreePath: wt('waitingHere'), ahead: 1, sessionIds: ['waitingHere'] }),
        item('d', { worktreePath: wt('dirty'), ahead: 1, dirtyCount: 3, sessionIds: ['dirty'] }),
        item('di', { worktreePath: wt('dirtyIdle'), dirtyCount: 1, sessionIds: ['dirtyIdle'] }),
        item('r', { worktreePath: wt('inReview'), ahead: 1, pr: pr(3, 'r', {}), sessionIds: ['inReview'] }),
        item('s', { worktreePath: wt('ready'), ahead: 4, sessionIds: ['ready'] }),
        item('n', { worktreePath: wt('nothing'), sessionIds: ['nothing'] }),
      ],
      { caughtUp: { at: NOW - 60 * MIN, prs: { 3: 'pending' } } },
    );
    const actions = Object.fromEntries(catchUp(s).flatMap((e) => (e.kind === 'session' ? [[e.session.sessionId, e.action]] : [])));
    expect(actions).toEqual({
      waitingHere: 'focus',
      waitingElsewhere: 'open',
      dirty: 'resume',
      dirtyIdle: 'open',
      inReview: 'openPr',
      ready: 'ship',
      nothing: 'open',
      mainline: 'open',
    });
  });

  it('keeps the newest session of a branch only', () => {
    const a = session('a', { updatedAt: NOW - 2 * MIN });
    const b = session('b', { updatedAt: NOW - MIN });
    const s = state([a, b], [main, item('x', { worktreePath: `${ROOT}/x`, sessionIds: ['b', 'a'] })], { caughtUp: { at: NOW - 60 * MIN, prs: {} } });
    expect(catchUp(s).map((e) => e.kind === 'session' && e.session.sessionId)).toEqual(['b']);
  });

  it('shows pull requests whose checks turned green or red, or that merged, since the mark', () => {
    const items = [
      main,
      item('green', { pr: pr(1, 'green', { checks: { state: 'success' } }) }),
      item('red', { pr: pr(2, 'red', { checks: { state: 'failure' } }) }),
      item('same', { pr: pr(3, 'same', { checks: { state: 'success' } }) }),
      item('worktree-0.2.0-ship-it', { pr: pr(4, 'worktree-0.2.0-ship-it', { state: 'merged' }) }),
      item('running', { pr: pr(5, 'running', {}) }),
      item('new', { pr: pr(6, 'new', { checks: { state: 'success' } }) }),
      item('newOld', { pr: pr(7, 'newOld', { checks: { state: 'success' }, updatedAt: NOW - 120 * MIN }) }),
    ];
    const s = state([], items, { caughtUp: { at: NOW - 60 * MIN, prs: { 1: 'pending', 2: 'success', 3: 'success', 4: 'success', 5: 'none' } } });
    const prs = catchUp(s).flatMap((e) => (e.kind === 'pr' ? [[e.pr.number, e.change, e.action, e.cards.length]] : []));
    expect(prs).toEqual(
      expect.arrayContaining([
        [1, 'passed', 'openPr', 0],
        [2, 'failed', 'openPr', 0],
        [4, 'merged', 'pull', 2],
        [6, 'passed', 'openPr', 0],
      ]),
    );
    expect(prs).toHaveLength(4);
    // Nothing to pull into when the main checkout is on another branch.
    const elsewhere = state([], [{ ...main, worktreePath: `${ROOT}-other` }, items[4] as WorkItem], { caughtUp: { at: NOW - 60 * MIN, prs: {} } });
    expect(catchUp(elsewhere)[0]).toMatchObject({ kind: 'pr', change: 'merged', action: 'openPr' });
  });

  it('keeps a session whose next action is still to take, however long ago it was seen', () => {
    const feat = item('feat', { worktreePath: `${ROOT}/wt`, ahead: 2, sessionIds: ['done'] });
    const s = state([session('done', { status: 'ended', live: false, updatedAt: NOW - 60 * MIN })], [main, feat], { caughtUp: { at: NOW, prs: {} } });
    expect(catchUp(s)).toMatchObject([{ kind: 'session', action: 'ship', item: { branch: 'feat' } }]);
    // Shipped: its pull request is open, and it is seen.
    const shipped = { ...feat, pr: pr(1, 'feat', {}) };
    expect(catchUp({ ...s, work: { ...s.work, items: [main, shipped] } })).toEqual([]);
  });

  it('is empty once caught up, and the mark round-trips', () => {
    const items = [main, item('green', { pr: pr(1, 'green', { checks: { state: 'success' } }) })];
    const s = state([session('done', { updatedAt: NOW - MIN })], items);
    expect(catchUp(s)).toHaveLength(2);
    const mark = markOf(s, NOW);
    expect(mark).toEqual({ at: NOW, prs: { 1: 'success' } });
    expect(catchUp({ ...s, caughtUp: mark })).toEqual([]);
    expect(parseMark(JSON.parse(JSON.stringify(mark)))).toEqual(mark);
    expect(parseMark({ at: 'soon', prs: {} })).toBeUndefined();
    expect(parseMark({ at: 1, prs: { 1: 'exploded', x: 'merged', 2: 'merged' } })).toEqual({ at: 1, prs: { 2: 'merged' } });
  });
});

describe('canShip and laneOf', () => {
  it('ships a clean branch ahead of the default one, in its own worktree, with no PR and no Claude at work', () => {
    const ready = item('b', { worktreePath: `${ROOT}/b`, ahead: 1, sessionIds: ['s'] });
    const ok = (i: WorkItem, sessions: ClaudeSession[] = [session('s', {})], extra: Partial<State['work']> = {}) => {
      const s = state(sessions, [main, i]);
      return canShip(i, { ...s, work: { ...s.work, ...extra } });
    };
    expect(ok(ready)).toBe(true);
    expect(ok({ ...ready, pr: pr(1, 'b', { state: 'closed' }) })).toBe(true);
    expect(ok({ ...ready, dirtyCount: 1 })).toBe(false);
    expect(ok({ ...ready, ahead: 0 })).toBe(false);
    expect(ok({ ...ready, worktreePath: undefined })).toBe(false);
    expect(ok({ ...ready, pr: pr(1, 'b', {}) })).toBe(false);
    expect(ok({ ...ready, pr: pr(1, 'b', { state: 'merged' }) })).toBe(false);
    expect(ok(ready, [session('s', { live: true, status: 'busy' })])).toBe(false);
    expect(ok(ready, undefined, { github: undefined })).toBe(false);
    expect(ok({ ...main, ahead: 1 })).toBe(false);
    const st = state([session('s', {})], [main, ready]);
    expect(shipProblem({ ...ready, dirtyCount: 2 }, st)).toBe('b has 2 uncommitted files: commit them, or resume its Claude, first.');
    expect(shipProblem({ ...ready, pr: pr(7, 'b', {}) }, st)).toBe('b already has pull request #7 (open).');
    expect(shipProblem(ready, { ...st, work: { ...st.work, github: undefined, githubNote: 'gh not logged in' } })).toBe('GitHub is not available here (gh not logged in): Cockpit publishes through gh.');
  });

  it("finds the lane of a branch's cards, else the backlog", () => {
    const s = state([], [main]);
    expect(laneOf(s, 'worktree-0.2.0-ship-it')).toBe('0.2.0');
    expect(laneOf(s, 'unlinked')).toBe('Backlog');
    expect(laneOf(s, undefined)).toBe('Backlog');
  });
});

describe('stillOpen', () => {
  it('lists the items under a "still open" heading', () => {
    const report = [
      '## What changed',
      '- Did a thing',
      '',
      '## Still open',
      '',
      '- Create the **API token** in the dashboard',
      '- Flip `WELCOME_LINK_TTL` in production',
      '  once the token works',
      '  - a nested detail',
      '',
      '## Verified',
      '- tests',
    ].join('\n');
    expect(stillOpen(report)).toEqual(['Create the API token in the dashboard', 'Flip WELCOME_LINK_TTL in production once the token works a nested detail']);
  });

  it('reads bold and colon headings and their variants', () => {
    expect(stillOpen('**Left open:**\n1. One\n2. Two\n\nThanks.')).toEqual(['One', 'Two']);
    expect(stillOpen('Anything left open:\n- [ ] Ask Rafa about [the docs](https://x)')).toEqual(['Ask Rafa about the docs']);
    expect(stillOpen('### Follow-ups\n* a\n\n* b\n')).toEqual(['a', 'b']);
  });

  it('shows nothing without such a list: no heading, a sentence, "none", or a list in a code block', () => {
    expect(stillOpen(undefined)).toEqual([]);
    expect(stillOpen('## Done\n- a\n- b')).toEqual([]);
    expect(stillOpen('**Still open:** the API token.')).toEqual([]);
    expect(stillOpen('## Still open\nNothing really, it is all in.')).toEqual([]);
    expect(stillOpen('## Still open\n- None.')).toEqual([]);
    expect(stillOpen('```\n## Still open\n- x\n```')).toEqual([]);
  });
});
