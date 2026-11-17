// Ship, Release, Tag and Pull: the git and gh commands behind them, without `vscode`, so the tests run them against a
// real repository with a bare remote. Every gh call goes through the `Gh` function passed in, which the tests
// replace. Each step says what it did; when one stops, the outcome says why and what was left behind.
// Two deliveries: `pr` pushes branches and opens pull requests on GitHub (the release too, from a temporary
// worktree); `direct` merges into the default branch in the main checkout and releases with a commit and a tag
// there, pushing only when asked.
import { lstat, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type RunResult, runGit } from './data/git';
import { parseChangelog, versionFrom } from './data/releases';
import { bumpLockfile, bumpVersion, datedChangelog, releaseBranch, releaseTitle, tagName } from './publish';

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

/** The tag exists here or on the remote (when `remote`): either way, it is not to be made again. */
async function tagTaken(repoRoot: string, tag: string, remote = true): Promise<string | undefined> {
  if ((await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`])).ok) return `${tag} is already tagged in this repository.`;
  if (!remote) return undefined;
  const found = await git(repoRoot, ['ls-remote', '--tags', REMOTE, `refs/tags/${tag}`], NETWORK_MS);
  if (!found.ok) return `Could not ask ${REMOTE} for its tags: ${why(found)}`;
  return found.stdout.trim() ? `${tag} is already tagged on ${REMOTE}.` : undefined;
}

/** The main checkout is on `base`: a direct merge or release happens there. */
async function onBase(repoRoot: string, base: string): Promise<string | undefined> {
  const head = await git(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return head.ok && head.stdout.trim() === base ? undefined : `The main checkout (${repoRoot}) is not on ${base}: switch it to ${base} first.`;
}

/** git tracks the file at `path` (from the root): a direct release then commits the board with it. */
export async function isTracked(repoRoot: string, path: string): Promise<boolean> {
  return (await git(repoRoot, ['ls-files', '--error-unmatch', '--', path])).ok;
}

// ───────────────────────────── Ship ─────────────────────────────

export interface ShipPlan {
  repoRoot: string;
  /** Where the branch is checked out, when it is: it must still be on the branch there, with nothing uncommitted. */
  worktree?: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

/** `pr` delivery: pushes the branch and opens its pull request. The board is not part of it: Cockpit never commits
 *  the board on a branch. */
export async function shipBranch(plan: ShipPlan, gh: Gh): Promise<Outcome> {
  const { worktree: wt, branch, base } = plan;
  const dir = wt ?? plan.repoRoot;
  const done: string[] = [];
  if (wt !== undefined) {
    const head = await git(wt, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
    if (!head.ok || head.stdout.trim() !== branch) return stop(done, `The worktree ${wt} is no longer on ${branch}.`);
    const status = await git(wt, ['status', '--porcelain']);
    if (!status.ok) return stop(done, `git status failed in ${wt}: ${why(status)}`);
    if (status.stdout.trim()) return stop(done, `${branch} has uncommitted changes in its worktree: commit them, or resume its Claude, before shipping.`);
  }

  const push = await git(dir, ['push', '--quiet', '--set-upstream', REMOTE, `refs/heads/${branch}:refs/heads/${branch}`], NETWORK_MS);
  if (!push.ok) return stop(done, `Pushing ${branch} to ${REMOTE} failed: ${why(push)}. Nothing was pushed.`);
  done.push(`pushed ${branch} to ${REMOTE}`);

  const pr = await gh(dir, ['pr', 'create', '--base', base, '--head', branch, '--title', plan.title, '--body', plan.body]);
  if (!pr.ok) return stop(done, `The pull request was not opened: ${why(pr)}. ${branch} is on ${REMOTE}; Ship again, or open the pull request on GitHub.`);
  const url = pr.stdout.trim().split('\n').pop()?.trim() ?? '';
  done.push(`opened ${url || 'the pull request'}`);
  return { ok: true, done, ...(url ? { url } : {}) };
}

/** `direct` delivery: merges the branch into `base` in the main checkout (a fast-forward when it can be one), then
 *  pushes `base` to origin when `push`. A merge that fails is undone, so `base` is left as it was. */
export async function mergeBranch(opts: { repoRoot: string; branch: string; base: string; push: boolean }): Promise<Outcome> {
  const { repoRoot, branch, base } = opts;
  const done: string[] = [];
  const off = await onBase(repoRoot, base);
  if (off) return stop(done, off);
  const tip = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
  if (!tip.ok) return stop(done, `${branch} is not a branch here.`);

  const merged = await git(repoRoot, ['merge', '--no-edit', branch], 60_000);
  if (!merged.ok) {
    const conflicts = (await git(repoRoot, ['diff', '--name-only', '--diff-filter=U'])).stdout.split('\n').filter(Boolean);
    const reason = conflicts.length ? `it conflicts in ${conflicts.join(', ')}` : why(merged);
    // A merge git refused to start (local changes in the way) left nothing to undo.
    if (!(await git(repoRoot, ['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'])).ok) return stop(done, `Merging ${branch} into ${base} failed: ${reason}. Nothing was changed.`);
    const aborted = await git(repoRoot, ['merge', '--abort']);
    return stop(done, `Merging ${branch} into ${base} failed: ${reason}. ${aborted.ok ? `The merge was undone: ${base} is as it was.` : `The merge could not be undone: ${repoRoot} is mid-merge.`}`);
  }
  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  done.push(head.stdout.trim() === tip.stdout.trim() ? `fast-forwarded ${base} to ${branch}` : `merged ${branch} into ${base}`);

  if (opts.push) {
    const pushed = await git(repoRoot, ['push', '--quiet', REMOTE, `refs/heads/${base}:refs/heads/${base}`], NETWORK_MS);
    if (!pushed.ok) return stop(done, `Pushing ${base} to ${REMOTE} failed: ${why(pushed)}. The merge is in your local ${base} only.`);
    done.push(`pushed ${base} to ${REMOTE}`);
  }
  return { ok: true, done };
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
  /** Direct delivery only: the exact inputs reviewed before confirmation, including absent optional files. */
  original?: { files: { path: string; bytes?: string }[]; index: string };
}

type Drafted = { ok: true; draft: ReleaseDraft } | { ok: false; error: string };

/** The release's edits, from files as `read` gives them (a path from the root, undefined when there is no such file):
 *  the version in package.json (and package-lock.json) and `versionFiles`, and CHANGELOG.md's Unreleased dated. `where` names what was read,
 *  for the errors. */
async function releaseFiles(
  read: (path: string) => Promise<string | undefined>,
  opts: { version: string; versionFiles: string[]; date: string; where: string },
): Promise<{ ok: true; files: ReleaseDraft['files']; notes: string[] } | { ok: false; error: string }> {
  const { version, where } = opts;
  const fail = (error: string) => ({ ok: false as const, error });
  // The root package.json when it has a version, and every file the setting names. The current version is
  // package.json's, else the first named manifest's.
  const bumps: { path: string; text: string }[] = [];
  const pkg = await read('package.json');
  if (pkg !== undefined && versionFrom('package.json', pkg)) bumps.push({ path: 'package.json', text: pkg });
  for (const path of opts.versionFiles.filter((f) => f !== 'package.json' && f !== 'package-lock.json')) {
    const text = await read(path);
    if (text === undefined) return fail(`${path} (cockpit.release.versionFiles) is not in ${where}.`);
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
  // npm's lockfile repeats package.json's version, so it moves with it.
  const lock = bumps[0]?.path === 'package.json' ? await read('package-lock.json') : undefined;
  if (lock !== undefined) {
    const r = bumpLockfile(lock, version);
    if (!r.ok) return fail(r.error);
    if (r.text !== lock) files.push({ path: 'package-lock.json', text: r.text, change: `→ ${version}` });
  }

  let notes: string[] = [];
  const changelog = await read('CHANGELOG.md');
  if (changelog !== undefined) {
    const r = datedChangelog(changelog, version, opts.date);
    if (!r.ok) return fail(r.error);
    notes = parseChangelog(changelog).find((e) => e.version === 'Unreleased')?.lines ?? [];
    files.push({ path: 'CHANGELOG.md', text: r.text, change: `"## Unreleased" → "## ${version} - ${opts.date}"` });
  }
  if (files.length === 0) return fail(`There is nothing to release: no version file or CHANGELOG.md in ${where}.`);
  return { ok: true, files, notes };
}

/** `pr` delivery: works out the release's edits on the up-to-date base, without changing anything. */
export async function draftRelease(opts: { repoRoot: string; base: string; version: string; versionFiles: string[]; date: string }): Promise<Drafted> {
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
  const made = await releaseFiles(show, { ...opts, where: `${REMOTE}/${base}` });
  if (!made.ok) return made;
  return { ok: true, draft: { repoRoot, base, version, branch, baseSha, files: made.files, notes: made.notes } };
}

/** `direct` delivery: works out the release's edits on the main checkout's files, which must be on `base`, without
 *  changing anything. A file it changes may not have uncommitted changes: the release commit holds its edits only.
 *  `remote`: the tag is also checked to be free on origin. */
export async function draftDirect(opts: { repoRoot: string; base: string; version: string; versionFiles: string[]; date: string; remote: boolean }): Promise<Drafted> {
  const { repoRoot, base, version } = opts;
  const fail = (error: string) => ({ ok: false as const, error });
  const off = await onBase(repoRoot, base);
  if (off) return fail(off);
  const taken = await tagTaken(repoRoot, tagName(version), opts.remote);
  if (taken) return fail(taken);
  const sha = await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!sha.ok) return fail(`${base} has no commit to release.`);
  const originals = new Map<string, string | undefined>();
  const made = await releaseFiles(async (path) => {
    const bytes = await readFile(join(repoRoot, path)).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });
    originals.set(path, bytes?.toString('base64'));
    return bytes?.toString('utf8');
  }, { ...opts, where: 'the main checkout' });
  if (!made.ok) return made;
  const paths = made.files.map((f) => f.path);
  const status = await git(repoRoot, ['status', '--porcelain', '--', ...paths]);
  if (!status.ok) return fail(`git status failed in ${repoRoot}: ${why(status)}`);
  const dirty = status.stdout.split('\n').filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) return fail(`${dirty.join(', ')} ${dirty.length === 1 ? 'has' : 'have'} uncommitted changes: commit them first. The release commit holds its own edits only.`);
  const index = await git(repoRoot, ['ls-files', '--stage', '-z', '--', ...originals.keys()]);
  if (!index.ok) return fail(`Could not read the release files' index state: ${why(index)}`);
  const original = { files: [...originals].map(([path, bytes]) => ({ path, ...(bytes === undefined ? {} : { bytes }) })), index: index.stdout };
  return { ok: true, draft: { repoRoot, base, version, branch: releaseBranch(version), baseSha: sha.stdout.trim(), files: made.files, notes: made.notes, original } };
}

/** Refuse overlapping releases across VS Code windows as well as within this process. A crashed owner's lock
 *  is deliberately not stolen: removing a lock whose owner is uncertain could allow two writers. */
async function releaseLock(repoRoot: string): Promise<{ release(): Promise<void> } | { error: string }> {
  const found = await git(repoRoot, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!found.ok) return { error: `Could not locate the repository's release lock: ${why(found)}` };
  const path = join(found.stdout.trim(), 'cockpit-release.lock');
  try {
    const lock = await open(path, 'wx');
    try {
      await lock.writeFile(`${process.pid}\n`);
    } catch (e) {
      await lock.close();
      await rm(path, { force: true });
      throw e;
    }
    return { release: async () => { await lock.close(); await rm(path, { force: true }); } };
  } catch (e) {
    return { error: (e as NodeJS.ErrnoException).code === 'EEXIST'
      ? `Another Cockpit release holds ${path}. Wait for it to finish; if its window crashed, remove that lock only after confirming no release is running.`
      : `Could not lock this repository for release: ${String(e)}` };
  }
}

async function changedReleaseInputs(draft: ReleaseDraft): Promise<string | undefined> {
  if (!draft.original) return 'This release has no original file snapshot: prepare the release again.';
  const paths = draft.original.files.map((f) => f.path);
  const index = await git(draft.repoRoot, ['ls-files', '--stage', '-z', '--', ...paths]);
  if (!index.ok) return `Could not recheck the release files' index state: ${why(index)}`;
  if (index.stdout !== draft.original.index) return 'The release files\' staged changes changed since the release was prepared: release again. Nothing was overwritten.';
  const status = await git(draft.repoRoot, ['status', '--porcelain', '--', ...draft.files.map((f) => f.path)]);
  if (!status.ok) return `Could not recheck the release files: ${why(status)}`;
  if (status.stdout.trim()) return 'The release files have uncommitted changes since the release was prepared: release again. Nothing was overwritten.';
  for (const f of draft.original.files) {
    const path = join(draft.repoRoot, f.path);
    // A replaced symlink is also a change: writing through it could change a different file entirely.
    const info = await lstat(path).catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return undefined;
      throw e;
    });
    const bytes = info?.isFile() ? await readFile(path) : undefined;
    if ((info && !info.isFile()) || bytes?.toString('base64') !== f.bytes) {
      return `${f.path} changed since the release was prepared: release again. Nothing was overwritten.`;
    }
  }
  return undefined;
}

/** `direct` delivery: writes the draft's files, commits only them as "Release X" on `base` in the main checkout, tags
 *  that commit vX (annotated), and pushes both at once when `push`. `roadmap` (the board's path from the root and its
 *  new text) is written and committed with them: pass it only when git tracks the board. A commit that fails puts
 *  every file back as it was. */
export async function commitRelease(draft: ReleaseDraft, opts: { roadmap?: { path: string; text: string; originalText?: string }; push: boolean }): Promise<Outcome> {
  const lock = await releaseLock(draft.repoRoot);
  if ('error' in lock) return stop([], lock.error);
  try {
    return await commitReleaseLocked(draft, opts);
  } finally {
    await lock.release();
  }
}

async function commitReleaseLocked(draft: ReleaseDraft, opts: { roadmap?: { path: string; text: string; originalText?: string }; push: boolean }): Promise<Outcome> {
  const { repoRoot, base, version } = draft;
  const done: string[] = [];
  const off = await onBase(repoRoot, base);
  if (off) return stop(done, off);
  const head = await git(repoRoot, ['rev-parse', 'HEAD']);
  if (!head.ok || head.stdout.trim() !== draft.baseSha) return stop(done, `${base} moved since the release was prepared: release again.`);

  const files = [...draft.files, ...(opts.roadmap ? [opts.roadmap] : [])];
  const paths = files.map((f) => f.path);
  const before = await Promise.all(paths.map((p) => readFile(join(repoRoot, p), 'utf8').catch(() => undefined)));
  const changed = await changedReleaseInputs(draft);
  if (changed) return stop(done, changed);
  if (opts.roadmap?.originalText !== undefined && before[before.length - 1] !== opts.roadmap.originalText) {
    return stop(done, `${opts.roadmap.path} changed since the release was prepared: release again. Nothing was overwritten.`);
  }
  for (const f of files) await writeFile(join(repoRoot, f.path), f.text, 'utf8');
  const title = releaseTitle(version);
  const commit = await git(repoRoot, ['commit', '--quiet', '-m', title, '--', ...paths]);
  if (!commit.ok) {
    let keptNewer = false;
    await Promise.all(files.map(async (f, i) => {
      // A hook or editor may write during git commit. Never roll that newer content back over.
      const current = await readFile(join(repoRoot, f.path), 'utf8').catch(() => undefined);
      if (current !== f.text) { keptNewer = true; return; }
      if (before[i] === undefined) await rm(join(repoRoot, f.path));
      else await writeFile(join(repoRoot, f.path), before[i] as string, 'utf8');
    }));
    return stop(done, `Could not commit the release: ${why(commit)}. ${keptNewer ? 'Newer file edits were kept; unchanged release edits were rolled back.' : 'The files are as they were.'}`);
  }
  done.push(`committed ${paths.join(', ')} on ${base} as "${title}"`);

  const tag = tagName(version);
  const tagged = await git(repoRoot, ['tag', '-a', '-m', title, tag, 'HEAD']);
  if (!tagged.ok) return stop(done, `Could not tag the release commit ${tag}: ${why(tagged)}. The commit stays on ${base}.`);
  done.push(`tagged it ${tag}`);

  if (opts.push) {
    const pushed = await git(repoRoot, ['push', '--quiet', '--atomic', REMOTE, `refs/heads/${base}:refs/heads/${base}`, `refs/tags/${tag}`], NETWORK_MS);
    if (!pushed.ok) return stop(done, `Pushing ${base} and ${tag} to ${REMOTE} failed: ${why(pushed)}. Neither was pushed; both are here.`);
    done.push(`pushed ${base} and ${tag} to ${REMOTE}`);
  }
  return { ok: true, done };
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

/** `direct` delivery: the commit a shipped lane's tag goes on, the default branch's tip, and the tag still free
 *  (here, and on origin when `remote`). */
export async function findDirectTag(repoRoot: string, base: string, version: string, remote: boolean): Promise<{ ok: true; sha: string } | { ok: false; error: string }> {
  const tip = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}^{commit}`]);
  if (!tip.ok) return { ok: false, error: `There is no local ${base} to tag.` };
  const taken = await tagTaken(repoRoot, tagName(version), remote);
  if (taken) return { ok: false, error: taken };
  return { ok: true, sha: tip.stdout.trim() };
}

/** Tags `sha` with an annotated tag (a tagger, a date and the message "Release X", which `git describe` and
 *  `git push --follow-tags` go by) and, when `push`, pushes it; a tag that could not be pushed is deleted again, so
 *  nothing is left half-made. Git needs a name and email to tag with, as it does to commit. */
export async function pushTag(repoRoot: string, version: string, sha: string, push = true): Promise<Outcome> {
  const tag = tagName(version);
  const done: string[] = [];
  const made = await git(repoRoot, ['tag', '-a', '-m', releaseTitle(version), tag, sha]);
  if (!made.ok) return stop(done, `Could not tag ${sha.slice(0, 7)}: ${why(made)}`);
  done.push(`tagged ${sha.slice(0, 7)} ${tag}`);
  if (!push) return { ok: true, done };
  const pushed = await git(repoRoot, ['push', '--quiet', REMOTE, `refs/tags/${tag}`], NETWORK_MS);
  if (!pushed.ok) {
    const removed = await git(repoRoot, ['tag', '-d', tag]);
    return stop(done, `Pushing ${tag} failed: ${why(pushed)}. ${removed.ok ? 'The local tag was deleted again.' : `The local tag ${tag} is still there.`}`);
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
  // Older git: "Applying autostash resulted in conflicts."; newer (2.56 at least): "…stashed, however applying them\nresulted in conflicts."
  if (/resulted in conflicts/i.test(said)) {
    return stop(['pulled'], 'Your uncommitted changes conflict with what came in: git left conflict markers in the files, and your changes are also safe in the stash (git stash list).');
  }
  if (!r.ok) return stop([], `git pull failed: ${why(r)}`);
  return { ok: true, done: [/already up to date/i.test(said) ? 'already up to date' : 'pulled'] };
}
