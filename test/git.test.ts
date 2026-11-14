import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  countStatusEntries,
  groupOf,
  parseBranchList,
  parseLog,
  parsePair,
  parseRefList,
  parseWorktreeList,
  projectRootOf,
  pushedBranches,
  readGit,
  recentCommits,
  resolveDefault,
  sortItems,
} from '../src/data/git';
import type { WorkItem } from '../src/model';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/git', name), 'utf8');
const DAY = 86_400_000;

describe('parseWorktreeList', () => {
  it('reads branches, detached, locked and prunable worktrees', () => {
    const list = parseWorktreeList(fixture('worktree-list.txt'));
    expect(list.map((w) => w.path)).toEqual([
      '/home/dev/acme',
      '/home/dev/acme/.claude/worktrees/search-filters',
      '/home/dev/acme/.claude/worktrees/agent-a1b2c3d4e5f6a7b8c',
      '/home/dev/acme/.claude/worktrees/spike',
      '/home/dev/acme/.claude/worktrees/gone',
    ]);
    expect(list[0]).toMatchObject({ branch: 'main', head: '1111111111111111111111111111111111111111', bare: false });
    expect(list[2]).toMatchObject({ branch: 'worktree-agent-a1b2c3d4e5f6a7b8c', locked: true });
    expect(list[3]).toMatchObject({ detached: true });
    expect(list[3]?.branch).toBeUndefined();
    expect(list[4]).toMatchObject({ branch: 'gone', prunable: true });
  });

  it('marks the bare entry of a bare repository', () => {
    const list = parseWorktreeList(fixture('worktree-list-bare.txt'));
    expect(list.map((w) => [w.path, w.bare, w.branch])).toEqual([
      ['/home/dev/widget.git', true, undefined],
      ['/home/dev/widget/main', false, 'main'],
    ]);
  });
});

describe('refs', () => {
  it('finds the default branch through origin/HEAD and the pushed branches', () => {
    const refs = parseRefList(fixture('refs.txt'));
    expect(refs).toContainEqual({ refname: 'refs/remotes/origin/HEAD', symref: 'refs/remotes/origin/main' });
    expect(resolveDefault(refs)).toEqual({ branch: 'main', local: 'refs/heads/main', remote: 'refs/remotes/origin/main' });
    expect([...pushedBranches(refs)].sort()).toEqual(['main', 'old-experiment', 'search-filters']);
  });

  it('prefers origin, else another remote HEAD, else main/master, else the fallback', () => {
    const two = parseRefList(fixture('refs-two-remotes.txt'));
    expect(resolveDefault(two)).toEqual({ branch: 'main', local: 'refs/heads/main', remote: 'refs/remotes/fork/main' });
    const upstreamOnly = two.filter((r) => !r.refname.startsWith('refs/remotes/fork/'));
    expect(resolveDefault(upstreamOnly)).toEqual({ branch: 'trunk', remote: 'refs/remotes/upstream/trunk' });
    expect(resolveDefault([{ refname: 'refs/heads/master' }, { refname: 'refs/heads/x' }])).toEqual({ branch: 'master', local: 'refs/heads/master' });
    expect(resolveDefault([{ refname: 'refs/heads/dev' }], 'dev')).toEqual({ branch: 'dev', local: 'refs/heads/dev' });
    expect(resolveDefault([{ refname: 'refs/heads/dev' }])).toBeUndefined();
  });
});

describe('parseBranchList', () => {
  it('reads dates, both ahead-behind columns and a subject with a tab', () => {
    const list = parseBranchList(fixture('branches.txt'), 2);
    expect(list).toHaveLength(4);
    expect(list[2]).toEqual({
      branch: 'search-filters',
      commitAt: 1794100000_000,
      subject: 'Search: filters by city and price\twith a tab',
      counts: [
        [4, 0],
        [4, 3],
      ],
    });
  });

  it('reads the format without counts (old git)', () => {
    expect(parseBranchList('main\t1794000000\tA subject\n', 0)).toEqual([{ branch: 'main', commitAt: 1794000000_000, subject: 'A subject', counts: [] }]);
  });

  it('parses both pair formats and rejects junk', () => {
    expect(parsePair('3 7')).toEqual([3, 7]);
    expect(parsePair('3\t7\n')).toEqual([3, 7]);
    expect(parsePair('')).toBeUndefined();
  });
});

describe('status and groups', () => {
  it('counts porcelain entries, renames and quoted names as one each', () => {
    expect(countStatusEntries(fixture('status.txt'))).toBe(5);
    expect(countStatusEntries('')).toBe(0);
  });

  it('applies the group rule', () => {
    const now = 100 * DAY;
    expect(groupOf({ isDefault: true, ahead: 5, dirtyCount: 3 }, now)).toBe('active');
    expect(groupOf({ isDefault: false, ahead: 0, dirtyCount: 0, lastCommitAt: 0 }, now)).toBe('merged');
    expect(groupOf({ isDefault: false, ahead: 0, dirtyCount: 0, unknown: true }, now)).toBe('active');
    expect(groupOf({ isDefault: false, ahead: 0, dirtyCount: 2, lastCommitAt: now - DAY }, now)).toBe('active');
    expect(groupOf({ isDefault: false, ahead: 1, dirtyCount: 0, lastCommitAt: now - 20 * DAY }, now)).toBe('stale');
    expect(groupOf({ isDefault: false, ahead: 1, dirtyCount: 0, lastCommitAt: now - 20 * DAY }, now, true)).toBe('active');
  });

  it('sorts default first, then active by last commit, merged, stale', () => {
    const item = (branch: string, group: WorkItem['group'], lastCommitAt: number, isDefault = false): WorkItem => ({
      branch, group, lastCommitAt, isDefault, isCurrent: false, dirtyCount: 0, ahead: 0, behind: 0, pushed: false, sessionIds: [],
    });
    const sorted = sortItems([item('s', 'stale', 9), item('m', 'merged', 9), item('a1', 'active', 1), item('main', 'active', 0, true), item('a2', 'active', 5)]);
    expect(sorted.map((i) => i.branch)).toEqual(['main', 'a2', 'a1', 'm', 's']);
  });

  it('parses git log lines into commit events', () => {
    const line = ['abcdef1234567890', '1794000000', 'A. Person', 'Fix: a subject'].join('\x1f');
    expect(parseLog(`${line}\n`, 'main')).toEqual([
      { kind: 'commit', at: 1794000000_000, title: 'Fix: a subject', detail: 'abcdef1 · A. Person', branch: 'main' },
    ]);
  });
});

// ───────────────────────────── A real repository ─────────────────────────────

describe('readGit on a real repository', () => {
  let base: string;
  let repo: string;
  const sh = (cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const commit = (cwd: string, file: string, message: string, env: NodeJS.ProcessEnv = {}) => {
    writeFileSync(join(cwd, file), `${message}\n`);
    sh(cwd, ['add', file]);
    sh(cwd, ['commit', '-q', '-m', message], env);
  };

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-git-')));
    repo = join(base, 'repo');
    mkdirSync(repo);
    sh(repo, ['init', '-q', '-b', 'main']);
    commit(repo, 'a.txt', 'first');
    commit(repo, 'b.txt', 'second');

    // A remote whose main moves ahead of the local main, like a pull request merged on GitHub.
    sh(base, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
    sh(repo, ['remote', 'add', 'origin', join(base, 'origin.git')]);
    sh(repo, ['push', '-q', '-u', 'origin', 'main']);
    sh(repo, ['remote', 'set-head', 'origin', 'main']);

    sh(repo, ['switch', '-q', '-c', 'merged-locally']);
    commit(repo, 'c.txt', 'merged locally');
    sh(repo, ['switch', '-q', 'main']);
    sh(repo, ['merge', '-q', '--no-ff', '-m', 'merge merged-locally', 'merged-locally']);
    sh(repo, ['push', '-q', 'origin', 'main']);

    sh(repo, ['switch', '-q', '-c', 'landed-on-github']);
    commit(repo, 'd.txt', 'landed on github');
    sh(repo, ['push', '-q', 'origin', 'landed-on-github:main']);
    sh(repo, ['switch', '-q', 'main']);
    sh(repo, ['fetch', '-q', 'origin']);

    sh(repo, ['switch', '-q', '-c', 'ahead']);
    commit(repo, 'e.txt', 'ahead one');
    commit(repo, 'f.txt', 'ahead two');
    sh(repo, ['push', '-q', 'origin', 'ahead']);
    sh(repo, ['switch', '-q', 'main']);

    const old = new Date(Date.now() - 30 * DAY).toISOString();
    sh(repo, ['switch', '-q', '-c', 'old-work']);
    commit(repo, 'g.txt', 'old work', { GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old });
    sh(repo, ['switch', '-q', 'main']);

    sh(repo, ['worktree', 'add', '-q', '-b', 'wip', join(base, 'wt-wip')]);
    writeFileSync(join(base, 'wt-wip', 'uncommitted.txt'), 'draft\n');
    mkdirSync(join(base, 'wt-wip', 'sub'));
    writeFileSync(join(base, 'wt-wip', 'sub', 'new.txt'), 'draft\n');

    // A worktree whose directory is deleted by hand: its branch must still show, without a path.
    sh(repo, ['worktree', 'add', '-q', '-b', 'deleted-by-hand', join(base, 'wt-gone')]);
    rmSync(join(base, 'wt-gone'), { recursive: true, force: true });

    // A detached worktree has no branch: left out.
    sh(repo, ['worktree', 'add', '-q', '--detach', join(base, 'wt-detached')]);
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('resolves projects: a worktree and a subfolder to the main checkout, outside git to itself', async () => {
    expect(await projectRootOf(repo)).toBe(repo);
    expect(await projectRootOf(join(base, 'wt-wip'))).toBe(repo);
    expect(await projectRootOf(join(base, 'wt-wip', 'sub'))).toBe(repo);
    expect(await projectRootOf(base)).toBe(base);
    expect(await projectRootOf(join(base, 'does-not-exist'))).toBe(join(base, 'does-not-exist'));
  });

  it('reads branches, groups, counts and worktrees', async () => {
    const g = await readGit(join(base, 'wt-wip'), Date.now());
    expect(g.available).toBe(true);
    expect(g.repoRoot).toBe(repo);
    expect(g.defaultBranch).toBe('main');
    const by = Object.fromEntries(g.items.map((i) => [i.branch, i]));
    // Commits made within the same second tie, so check the order by group, not the exact sequence.
    expect(g.items[0]?.branch).toBe('main');
    expect(g.items.slice(1).map((i) => i.group)).toEqual(['active', 'active', 'merged', 'merged', 'merged', 'stale']);
    expect(Object.keys(by).sort()).toEqual(['ahead', 'deleted-by-hand', 'landed-on-github', 'main', 'merged-locally', 'old-work', 'wip']);

    // Local main is one behind origin/main, so branches are measured against origin/main.
    expect(by.main).toMatchObject({ isDefault: true, group: 'active', ahead: 0, behind: 1, pushed: true, worktreePath: repo, isCurrent: false });
    expect(by.ahead).toMatchObject({ group: 'active', ahead: 2, behind: 1, pushed: true, lastCommitSubject: 'ahead two' });
    expect(by['landed-on-github']).toMatchObject({ group: 'merged', ahead: 0, behind: 0, pushed: false });
    expect(by['merged-locally']).toMatchObject({ group: 'merged', ahead: 0, behind: 2 });
    expect(by.wip).toMatchObject({ group: 'active', dirtyCount: 2, isCurrent: true, worktreePath: join(base, 'wt-wip') });
    expect(by['deleted-by-hand']).toMatchObject({ group: 'merged', dirtyCount: 0 });
    expect(by['deleted-by-hand']?.worktreePath).toBeUndefined();
    expect(by['old-work']).toMatchObject({ group: 'stale', ahead: 1 });
    for (const i of g.items) expect(i.sessionIds).toEqual([]);
  });

  it('gives the same result on a git without %(ahead-behind:) (before 2.41), through rev-list', async () => {
    const fast = await readGit(join(base, 'wt-wip'), Date.now());
    // A git on PATH that rejects the atom the way old versions do, and runs the real git otherwise.
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(base, 'old-git-bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\nfor a in "$@"; do case "$a" in *ahead-behind*) echo rejected >> "${join(bin, 'log')}"; echo "fatal: unknown field name: ahead-behind" >&2; exit 128;; esac; done\nexec "${realGit}" "$@"\n`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ''}`;
    try {
      expect(await readGit(join(base, 'wt-wip'), Date.now())).toEqual(fast);
      expect(readFileSync(join(bin, 'log'), 'utf8')).toContain('rejected');
    } finally {
      process.env.PATH = path;
    }
  });

  it('says unavailable outside git', async () => {
    expect(await readGit(base, Date.now())).toEqual({ available: false, items: [] });
  });

  it('lists recent commits of the default branch, including the remote-only one', async () => {
    const commits = await recentCommits(repo, 3);
    expect(commits).toHaveLength(3);
    expect(commits.map((c) => c.title)).toContain('landed on github');
    expect(commits.every((c) => c.kind === 'commit' && c.branch === 'main' && c.at > 0)).toBe(true);
    expect(await recentCommits(base, 3)).toEqual([]);
  });
});
