// Ship, Release, Tag and Pull: the git and gh commands behind them, without `vscode`, so the tests run them against a
// real repository with a bare remote. Every gh call goes through the `Gh` function passed in, which the tests
// replace. Each step says what it did; when one stops, the outcome says why and what was left behind.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type RunResult, runGit } from './data/git';
import { parseChangelog, versionFrom } from './data/releases';
import { bumpVersion, datedChangelog, releaseBranch, releaseTitle, tagName } from './publish';

export type Gh = (cwd: string, args: string[]) => Promise<RunResult>;

/** What a step did: `done` lists what happened, in order; `error` is why it stopped, when it did. */
export interface Outcome {
  ok: boolean;
  done: string[];
  error?: string;
  /** The pull request opened. */
  url?: string;
}

/** The remote everything is pushed to. */
export const REMOTE = 'origin';

const NETWORK_MS = 120_000;
const git = (dir: string, args: string[], timeoutMs = 30_000) => runGit(dir, args, timeoutMs);
const why = (r: RunResult): string => (r.timedOut ? 'timed out' : ((r.stderr.trim() || r.stdout.trim()).split('\n').find((l) => l.trim()) ?? `exit ${String(r.code ?? '?')}`));
const stop = (done: string[], error: string): Outcome => ({ ok: false, done, error });

// ───────────────────────────── Checks ─────────────────────────────

export interface PrInfo {
  number: number;
  state: 'open' | 'merged' | 'closed';
  url: string;
  mergeCommit?: string;
}

/** The pull requests from `branch`, the open one first, then merged ones; or why gh could not tell. */
export async function prsFrom(gh: Gh, repoRoot: string, branch: string): Promise<{ ok: true; prs: PrInfo[] } | { ok: false; error: string }> {
  const r = await gh(repoRoot, ['pr', 'list', '--head', branch, '--state', 'all', '--limit', '10', '--json', 'number,state,url,mergeCommit']);
  if (!r.ok) return { ok: false, error: r.code === 'ENOENT' ? 'gh is not installed.' : `gh could not list the pull requests: ${why(r)}` };
  let list: unknown;
  try {
    list = JSON.parse(r.stdout);
  } catch {
    return { ok: false, error: 'gh answered with something that is not a list of pull requests.' };
  }
  const prs: PrInfo[] = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (typeof p !== 'object' || p === null) continue;
    const o = p as Record<string, unknown>;
    const state = String(o.state).toLowerCase();
    if (typeof o.number !== 'number' || (state !== 'open' && state !== 'merged' && state !== 'closed')) continue;
    const merge = o.mergeCommit as { oid?: unknown } | null | undefined;
    prs.push({ number: o.number, state, url: typeof o.url === 'string' ? o.url : '', ...(typeof merge?.oid === 'string' ? { mergeCommit: merge.oid } : {}) });
  }
  const rank = { open: 0, merged: 1, closed: 2 } as const;
  return { ok: true, prs: prs.sort((a, b) => rank[a.state] - rank[b.state]) };
}

/** Why the repository cannot publish, or undefined when it has the remote. */
export async function remoteProblem(repoRoot: string): Promise<string | undefined> {
  const r = await git(repoRoot, ['remote', 'get-url', REMOTE]);
  return r.ok ? undefined : `This repository has no remote named "${REMOTE}" to push to.`;
}

// Only the base branch: no tags come along (a fetch follows tags by default), so nothing else in the repository changes.
const fetchBase = (dir: string, base: string) => git(dir, ['fetch', '--quiet', '--no-tags', REMOTE, `refs/heads/${base}:refs/remotes/${REMOTE}/${base}`], NETWORK_MS);

/** The tag exists here or on the remote: either way, it is not to be made again. */
async function tagTaken(repoRoot: string, tag: string): Promise<string | undefined> {
  if ((await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])).ok) return `${tag} is already tagged in this repository.`;
  const remote = await git(repoRoot, ['ls-remote', '--tags', REMOTE, `refs/tags/${tag}`], NETWORK_MS);
  if (!remote.ok) return `Could not ask ${REMOTE} for its tags: ${why(remote)}`;
  return remote.stdout.trim() ? `${tag} is already tagged on ${REMOTE}.` : undefined;
}

// ───────────────────────────── Ship ─────────────────────────────

/** ROADMAP.md as the remote's base branch has it, fetched first (as last fetched when the fetch fails): what a
 *  pull request into it changes the board from. Undefined when it has no ROADMAP.md. */
export async function baseRoadmap(dir: string, base: string): Promise<string | undefined> {
  await fetchBase(dir, base);
  const r = await git(dir, ['show', `refs/remotes/${REMOTE}/${base}:ROADMAP.md`]);
  return r.ok ? r.stdout : undefined;
}

export interface ShipPlan {
  /** The branch's worktree: where its commits are made and pushed from. */
  worktree: string;
  branch: string;
  base: string;
  /** What ROADMAP.md (at the root) is to read on the branch; undefined leaves it alone. */
  roadmap?: string;
  commitMessage: string;
  title: string;
  body: string;
}

/** Commits ROADMAP.md on the branch (merging the base in first when the base's ROADMAP.md changed since the branch
 *  started, so the pull request merges cleanly), pushes the branch and opens its pull request. */
export async function shipBranch(plan: ShipPlan, gh: Gh): Promise<Outcome> {
  const { worktree: wt, branch, base } = plan;
  const done: string[] = [];
  const head = await git(wt, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (!head.ok || head.stdout.trim() !== branch) return stop(done, `The worktree ${wt} is no longer on ${branch}.`);
  const status = await git(wt, ['status', '--porcelain']);
  if (!status.ok) return stop(done, `git status failed in ${wt}: ${why(status)}`);
  if (status.stdout.trim()) return stop(done, `${branch} has uncommitted changes in its worktree: commit them, or resume its Claude, before shipping.`);
  const fetched = await fetchBase(wt, base);
  if (!fetched.ok) return stop(done, `Could not fetch ${base} from ${REMOTE}: ${why(fetched)}`);
  const remoteBase = `${REMOTE}/${base}`;

  if (plan.roadmap !== undefined) {
    const mergeBase = await git(wt, ['merge-base', 'HEAD', remoteBase]);
    const blob = async (rev: string) => {
      const r = await git(wt, ['rev-parse', '--verify', '--quiet', `${rev}:ROADMAP.md`]);
      return r.ok ? r.stdout.trim() : '';
    };
    if (!mergeBase.ok || (await blob(mergeBase.stdout.trim())) !== (await blob(remoteBase))) {
      const merged = await git(wt, ['merge', '--no-edit', remoteBase], 60_000);
      if (!merged.ok) {
        const aborted = await git(wt, ['merge', '--abort']);
        return stop(
          done,
          `${remoteBase} changed ROADMAP.md since ${branch} started, and merging it into the branch conflicts (${why(merged)}). ${aborted.ok ? 'The merge was undone; nothing was pushed.' : `The merge could not be undone: ${wt} is mid-merge.`}`,
        );
      }
      done.push(`merged ${remoteBase} into ${branch}`);
    }
    await writeFile(join(wt, 'ROADMAP.md'), plan.roadmap, 'utf8');
    const changed = await git(wt, ['status', '--porcelain', '--', 'ROADMAP.md']);
    if (changed.stdout.trim()) {
      const add = await git(wt, ['add', '--', 'ROADMAP.md']);
      const commit = add.ok ? await git(wt, ['commit', '--quiet', '-m', plan.commitMessage]) : add;
      if (!commit.ok) {
        await git(wt, ['checkout', 'HEAD', '--', 'ROADMAP.md']);
        return stop(done, `Could not commit ROADMAP.md on ${branch}: ${why(commit)}. Nothing was pushed.`);
      }
      done.push(`committed ROADMAP.md on ${branch}`);
    }
  }

  const push = await git(wt, ['push', '--quiet', '--set-upstream', REMOTE, `refs/heads/${branch}:refs/heads/${branch}`], NETWORK_MS);
  if (!push.ok) return stop(done, `Pushing ${branch} to ${REMOTE} failed: ${why(push)}. Nothing was pushed.`);
  done.push(`pushed ${branch} to ${REMOTE}`);

  const pr = await gh(wt, ['pr', 'create', '--base', base, '--head', branch, '--title', plan.title, '--body', plan.body]);
  if (!pr.ok) return stop(done, `The pull request was not opened: ${why(pr)}. ${branch} is on ${REMOTE}; Ship again, or open the pull request on GitHub.`);
  const url = pr.stdout.trim().split('\n').pop()?.trim() ?? '';
  done.push(`opened ${url || 'the pull request'}`);
  return { ok: true, done, ...(url ? { url } : {}) };
}

// ───────────────────────────── Release ─────────────────────────────

export interface ReleaseDraft {
  repoRoot: string;
  base: string;
  version: string;
  branch: string;
  /** The base commit the release starts from: what the confirmation was worked out on. */
  baseSha: string;
  /** Each file's new content, and the change in a few words. */
  files: { path: string; text: string; change: string }[];
  /** The Unreleased lines of the changelog. */
  notes: string[];
}

/** Works out the release's edits on the up-to-date base, without changing anything: the version in package.json and
 *  `versionFiles`, CHANGELOG.md's Unreleased dated, and `roadmap` (ROADMAP.md as it is to read). */
export async function draftRelease(opts: {
  repoRoot: string;
  base: string;
  version: string;
  versionFiles: string[];
  roadmap?: string;
  date: string;
}): Promise<{ ok: true; draft: ReleaseDraft } | { ok: false; error: string }> {
  const { repoRoot, base, version } = opts;
  const branch = releaseBranch(version);
  const fail = (error: string) => ({ ok: false as const, error });
  const fetched = await fetchBase(repoRoot, base);
  if (!fetched.ok) return fail(`Could not fetch ${base} from ${REMOTE}: ${why(fetched)}`);
  const sha = await git(repoRoot, ['rev-parse', '--verify', `refs/remotes/${REMOTE}/${base}^{commit}`]);
  if (!sha.ok) return fail(`${REMOTE}/${base} is not there to release from.`);
  if ((await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])).ok) return fail(`A branch ${branch} exists already. Delete it, or finish its release, first.`);
  const remoteBranch = await git(repoRoot, ['ls-remote', '--heads', REMOTE, `refs/heads/${branch}`], NETWORK_MS);
  if (!remoteBranch.ok) return fail(`Could not ask ${REMOTE} for its branches: ${why(remoteBranch)}`);
  if (remoteBranch.stdout.trim()) return fail(`${REMOTE} has a branch ${branch} already.`);
  const taken = await tagTaken(repoRoot, tagName(version));
  if (taken) return fail(taken);

  const baseSha = sha.stdout.trim();
  const show = async (path: string): Promise<string | undefined> => {
    const r = await git(repoRoot, ['show', `${baseSha}:${path}`]);
    return r.ok ? r.stdout : undefined;
  };
  // The root package.json when it has a version, and every file the setting names. The current version is
  // package.json's, else the first named manifest's.
  const bumps: { path: string; text: string }[] = [];
  const pkg = await show('package.json');
  if (pkg !== undefined && versionFrom('package.json', pkg)) bumps.push({ path: 'package.json', text: pkg });
  for (const path of opts.versionFiles.filter((f) => f !== 'package.json')) {
    const text = await show(path);
    if (text === undefined) return fail(`${path} (cockpit.release.versionFiles) is not in ${REMOTE}/${base}.`);
    bumps.push({ path, text });
  }
  const from = bumps.map((b) => versionFrom(b.path, b.text)).find(Boolean);
  if (bumps.length && !from) return fail(`Cannot tell the current version from ${bumps.map((b) => b.path).join(', ')}.`);
  if (from === version) return fail(`The version is ${version} already.`);
  const files: ReleaseDraft['files'] = [];
  for (const b of bumps) {
    const r = bumpVersion(b.path, b.text, from as string, version);
    if (!r.ok) return fail(r.error);
    files.push({ path: b.path, text: r.text, change: `${from} → ${version}` });
  }

  let notes: string[] = [];
  const changelog = await show('CHANGELOG.md');
  if (changelog !== undefined) {
    const r = datedChangelog(changelog, version, opts.date);
    if (!r.ok) return fail(r.error);
    notes = parseChangelog(changelog).find((e) => e.version === 'Unreleased')?.lines ?? [];
    files.push({ path: 'CHANGELOG.md', text: r.text, change: `"## Unreleased" → "## ${version} - ${opts.date}"` });
  }
  if (opts.roadmap !== undefined) files.push({ path: 'ROADMAP.md', text: opts.roadmap, change: `${version}: Status: shipped` });
  if (files.length === 0) return fail(`There is nothing to release: no version file, CHANGELOG.md or ROADMAP.md in ${REMOTE}/${base}.`);
  return { ok: true, draft: { repoRoot, base, version, branch, baseSha, files, notes } };
}

/** Commits the draft on a new branch from its base commit, in a temporary worktree (the main checkout is not
 *  touched), pushes the branch and opens the release pull request. The worktree is removed either way; the branch
 *  is removed too when nothing was pushed. */
export async function openRelease(draft: ReleaseDraft, title: string, body: string, gh: Gh): Promise<Outcome> {
  const { repoRoot, branch } = draft;
  const done: string[] = [];
  const dir = join(await mkdtemp(join(tmpdir(), 'cockpit-release-')), draft.version);
  let created = false;
  let pushed = false;
  try {
    const add = await git(repoRoot, ['worktree', 'add', '--quiet', '-b', branch, dir, draft.baseSha]);
    if (!add.ok) return stop(done, `Could not create ${branch}: ${why(add)}`);
    created = true;
    for (const f of draft.files) await writeFile(join(dir, f.path), f.text, 'utf8');
    const staged = await git(dir, ['add', '--', ...draft.files.map((f) => f.path)]);
    const commit = staged.ok ? await git(dir, ['commit', '--quiet', '-m', title]) : staged;
    if (!commit.ok) return stop(done, `Could not commit the release: ${why(commit)}`);
    done.push(`committed ${draft.files.map((f) => f.path).join(', ')} on ${branch}`);
    const push = await git(dir, ['push', '--quiet', '--set-upstream', REMOTE, `refs/heads/${branch}:refs/heads/${branch}`], NETWORK_MS);
    if (!push.ok) return stop(done, `Pushing ${branch} to ${REMOTE} failed: ${why(push)}. Nothing was pushed.`);
    pushed = true;
    done.push(`pushed ${branch} to ${REMOTE}`);
    const pr = await gh(dir, ['pr', 'create', '--base', draft.base, '--head', branch, '--title', title, '--body', body]);
    if (!pr.ok) return stop(done, `The pull request was not opened: ${why(pr)}. ${branch} is on ${REMOTE}: open its pull request on GitHub.`);
    const url = pr.stdout.trim().split('\n').pop()?.trim() ?? '';
    done.push(`opened ${url || 'the pull request'}`);
    return { ok: true, done, ...(url ? { url } : {}) };
  } finally {
    // Cockpit's own temporary worktree: whatever is left in it is the release edit, which the branch has or never had.
    await git(repoRoot, ['worktree', 'remove', '--force', dir]);
    await rm(dirname(dir), { recursive: true, force: true });
    if (created && !pushed && (await git(repoRoot, ['branch', '-D', branch])).ok) done.push(`removed the local ${branch} again`);
  }
}

// ───────────────────────────── Tag ─────────────────────────────

/** The commit the release pull request merged as, checked to be on the base branch, and the tag still free. */
export async function findRelease(gh: Gh, repoRoot: string, base: string, version: string): Promise<{ ok: true; sha: string; pr: number } | { ok: false; error: string }> {
  const branch = releaseBranch(version);
  const list = await prsFrom(gh, repoRoot, branch);
  if (!list.ok) return list;
  const merged = list.prs.find((p) => p.state === 'merged' && p.mergeCommit);
  if (!merged?.mergeCommit) return { ok: false, error: `No merged pull request from ${branch}: merge the release pull request first.` };
  const fetched = await fetchBase(repoRoot, base);
  if (!fetched.ok) return { ok: false, error: `Could not fetch ${base} from ${REMOTE}: ${why(fetched)}` };
  const onBase = await git(repoRoot, ['merge-base', '--is-ancestor', merged.mergeCommit, `refs/remotes/${REMOTE}/${base}`]);
  if (!onBase.ok) return { ok: false, error: `The merge of #${merged.number} (${merged.mergeCommit.slice(0, 7)}) is not on ${REMOTE}/${base}.` };
  const taken = await tagTaken(repoRoot, tagName(version));
  if (taken) return { ok: false, error: taken };
  return { ok: true, sha: merged.mergeCommit, pr: merged.number };
}

/** Tags `sha` with an annotated tag (a tagger, a date and the message "Release X", which `git describe` and
 *  `git push --follow-tags` go by) and pushes it; a tag that could not be pushed is deleted again, so nothing is left
 *  half-made. Git needs a name and email to tag with, as it does to commit. */
export async function pushTag(repoRoot: string, version: string, sha: string): Promise<Outcome> {
  const tag = tagName(version);
  const done: string[] = [];
  const made = await git(repoRoot, ['tag', '-a', '-m', releaseTitle(version), tag, sha]);
  if (!made.ok) return stop(done, `Could not tag ${sha.slice(0, 7)}: ${why(made)}`);
  done.push(`tagged ${sha.slice(0, 7)} ${tag}`);
  const push = await git(repoRoot, ['push', '--quiet', REMOTE, `refs/tags/${tag}`], NETWORK_MS);
  if (!push.ok) {
    const removed = await git(repoRoot, ['tag', '-d', tag]);
    return stop(done, `Pushing ${tag} failed: ${why(push)}. ${removed.ok ? 'The local tag was deleted again.' : `The local tag ${tag} is still there.`}`);
  }
  done.push(`pushed ${tag} to ${REMOTE}`);
  return { ok: true, done };
}

// ───────────────────────────── Pull ─────────────────────────────

/** `git pull --ff-only --autostash` in the main checkout. git exits 0 when the stash does not apply cleanly over what
 *  came in, so its words are read too. */
export async function pullDefault(repoRoot: string): Promise<Outcome> {
  const r = await git(repoRoot, ['pull', '--ff-only', '--autostash'], NETWORK_MS);
  const said = `${r.stdout}\n${r.stderr}`;
  if (/autostash resulted in conflicts/i.test(said)) {
    return stop(['pulled'], 'Your uncommitted changes conflict with what came in: git left conflict markers in the files, and your changes are also safe in the stash (git stash list).');
  }
  if (!r.ok) return stop([], `git pull failed: ${why(r)}`);
  return { ok: true, done: [/already up to date/i.test(said) ? 'already up to date' : 'pulled'] };
}
