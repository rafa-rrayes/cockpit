// The removing half of "Clean merged", without `vscode` so it is tested against real repositories: actions.ts asks
// first and calls this with what the person confirmed.
import { defaultRefs, runGit } from './data/git';
import type { WorkItem } from './model';

/** The branch's commits are all in the default branch, local or remote copy: the test Cockpit's "merged" stands for.
 *  `git branch -d` would test against HEAD or an upstream instead, and refuse a branch merged on GitHub but not
 *  pulled yet (after its worktree was already gone), so the branch is verified here and then deleted with -D. */
async function mergedInto(repoRoot: string, branch: string, bases: string[]): Promise<boolean> {
  for (const base of bases) {
    const r = await runGit(repoRoot, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, base], 15_000);
    if (r.ok) return true;
  }
  return false;
}

const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';

/** Removes each item's worktree, then its branch, when the branch is verified merged before and after. `inUse`
 *  says an item stopped being a candidate since the person confirmed (a Claude or a window opened there). */
export async function removeMerged(
  repoRoot: string,
  items: WorkItem[],
  inUse: (item: WorkItem) => boolean,
): Promise<{ removed: string[]; kept: string[] }> {
  const def = await defaultRefs(repoRoot);
  const bases = def ? [def.local, def.remote].filter((b): b is string => Boolean(b)) : [];
  const name = def?.branch ?? 'the default branch';
  const removed: string[] = [];
  const kept: string[] = [];
  for (const item of items) {
    if (inUse(item)) {
      kept.push(`${item.branch}: in use now (a Claude, a window or a change appeared)`);
      continue;
    }
    if (!(await mergedInto(repoRoot, item.branch, bases))) {
      kept.push(`${item.branch}: has commits ${name} lacks`);
      continue;
    }
    if (item.worktreePath) {
      const r = await runGit(repoRoot, ['worktree', 'remove', item.worktreePath], 30_000);
      if (!r.ok) {
        kept.push(`${item.branch}: ${firstLine(r.stderr) || 'git worktree remove failed'}`);
        continue;
      }
      // Nothing can commit to the branch once its worktree is gone; check that nothing did just before.
      if (!(await mergedInto(repoRoot, item.branch, bases))) {
        kept.push(`${item.branch}: got a commit ${name} lacks (its worktree was removed, the branch is kept)`);
        continue;
      }
    }
    const r = await runGit(repoRoot, ['branch', '-D', item.branch], 15_000);
    if (r.ok) removed.push(item.worktreePath ? `${item.branch} and its worktree` : item.branch);
    else kept.push(`${item.branch}: ${firstLine(r.stderr) || 'git branch -D failed'}${item.worktreePath ? ' (its worktree was removed)' : ''}`);
  }
  return { removed, kept };
}
