// "Clean merged" against a real repository shaped like the one that broke it: local main behind origin/main, and
// branches merged only on the remote, each in a worktree inside the main checkout.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeMerged } from '../src/clean';
import type { WorkItem } from '../src/model';

describe('removeMerged', () => {
  let base: string;
  let repo: string;
  const sh = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    sh(cwd, ['add', file]);
    sh(cwd, ['commit', '-q', '-m', file]);
  };
  const wt = (name: string) => join(repo, '.claude', 'worktrees', name);
  const item = (branch: string, worktreePath?: string): WorkItem => ({
    branch,
    isDefault: false,
    isCurrent: false,
    group: 'merged',
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    pushed: false,
    sessionIds: [],
    ...(worktreePath ? { worktreePath } : {}),
  });
  const branches = () => sh(repo, ['branch', '--format=%(refname:short)']).split('\n').filter(Boolean).sort();

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-clean-')));
    repo = join(base, 'repo');
    mkdirSync(repo);
    sh(repo, ['init', '-q', '-b', 'main']);
    commit(repo, 'a.txt');
    sh(base, ['init', '-q', '--bare', '-b', 'main', 'origin.git']);
    sh(repo, ['remote', 'add', 'origin', join(base, 'origin.git')]);
    sh(repo, ['push', '-q', '-u', 'origin', 'main']);
    sh(repo, ['remote', 'set-head', 'origin', 'main']);

    // Merged on GitHub (pushed to origin/main), never pulled: not in local main, so `git branch -d` refuses it.
    sh(repo, ['worktree', 'add', '-q', '-b', 'landed', wt('landed')]);
    commit(wt('landed'), 'landed.txt');
    sh(wt('landed'), ['push', '-q', 'origin', 'landed:main']);
    sh(repo, ['fetch', '-q', 'origin']);
    // Ignored files go with the worktree.
    writeFileSync(join(wt('landed'), '.gitignore'), 'node_modules/\n.gitignore\n');
    mkdirSync(join(wt('landed'), 'node_modules'));
    writeFileSync(join(wt('landed'), 'node_modules', 'x.js'), '1\n');

    // Has a commit neither main has: its worktree must stay.
    sh(repo, ['worktree', 'add', '-q', '-b', 'unmerged', wt('unmerged')]);
    commit(wt('unmerged'), 'unmerged.txt');

    // Merged locally, no worktree.
    sh(repo, ['branch', 'plain']);
    // Became busy while the dialog was open.
    sh(repo, ['worktree', 'add', '-q', '-b', 'busy-now', wt('busy-now')]);
  });

  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('removes branches merged into the local or remote default branch, worktree first, and keeps the rest whole', async () => {
    const items = [item('landed', wt('landed')), item('unmerged', wt('unmerged')), item('plain'), item('busy-now', wt('busy-now'))];
    const { removed, kept } = await removeMerged(repo, items, (i) => i.branch === 'busy-now');
    expect(removed).toEqual(['landed and its worktree', 'plain']);
    expect(kept).toEqual(['unmerged: has commits main lacks', 'busy-now: in use now (an agent, a window or a change appeared)']);
    expect(existsSync(wt('landed'))).toBe(false);
    expect(existsSync(wt('unmerged'))).toBe(true);
    expect(existsSync(wt('busy-now'))).toBe(true);
    expect(branches()).toEqual(['busy-now', 'main', 'unmerged']);
  });
});
