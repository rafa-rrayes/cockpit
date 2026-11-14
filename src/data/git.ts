// Git adapter: worktrees, branches and their state, read with a handful of git commands.
// Pure parsers (exported for tests) are kept apart from the functions that run commands.
// Nothing here throws on git failures: a missing repository, an old git or a broken worktree degrades the result.
import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ActivityEvent, WorkGroup, WorkItem } from '../model';

// ───────────────────────────── Running commands ─────────────────────────────

export interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** Exit code, or the spawn error code ("ENOENT"). */
  code?: number | string;
  timedOut: boolean;
}

/** Runs a command without a shell. Never rejects: failures come back as ok: false. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs ?? 8000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...opts.env } },
      (err, stdout, stderr) => {
        if (!err) return resolve({ ok: true, stdout, stderr, timedOut: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
        resolve({ ok: false, stdout, stderr, code: e.code, timedOut: Boolean(e.killed && e.signal) });
      },
    );
  });
}

// GIT_OPTIONAL_LOCKS=0: `git status` must not take index.lock, or it can collide with a Claude committing in that worktree.
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' };

/** git in `dir` (through -C, so a missing directory is a git error, not a spawn error). Shared with releases.ts. */
export const runGit = (dir: string, args: string[], timeoutMs = 8000) => run('git', ['-C', dir, ...args], { timeoutMs, env: GIT_ENV });
const git = runGit;

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// git prints real paths for some things and recorded paths for others (/tmp vs /private/tmp on macOS): compare real ones.
const real = (p: string) => realpath(p).catch(() => p);

// ───────────────────────────── Pure parsers ─────────────────────────────

export interface WorktreeEntry {
  path: string;
  head?: string;
  /** Short branch name; absent when detached. */
  branch?: string;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** git knows the directory is gone (deleted by hand without `git worktree remove`). */
  prunable: boolean;
}

/** Parses `git worktree list --porcelain`: blank-line separated records of "key value" lines. */
export function parseWorktreeList(text: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = [];
  let cur: WorktreeEntry | undefined;
  for (const line of text.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), bare: false, detached: false, locked: false, prunable: false };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const sp = line.indexOf(' ');
    const key = sp < 0 ? line : line.slice(0, sp);
    const value = sp < 0 ? '' : line.slice(sp + 1);
    if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') cur.bare = true;
    else if (key === 'detached') cur.detached = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  return out;
}

export interface RefEntry {
  refname: string;
  /** Target of a symbolic ref (refs/remotes/origin/HEAD → refs/remotes/origin/main). */
  symref?: string;
}

/** Parses `for-each-ref --format=%(refname)%09%(symref)`. */
export function parseRefList(text: string): RefEntry[] {
  const out: RefEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [refname = '', symref = ''] = line.split('\t');
    out.push(symref ? { refname, symref } : { refname });
  }
  return out;
}

export interface DefaultRefs {
  branch: string;
  /** refs/heads/<branch>, when the branch exists locally. */
  local?: string;
  /** refs/remotes/<remote>/<branch>, when the remote has it. */
  remote?: string;
}

/** The default branch: the remote's HEAD (origin first), else a local main or master, else `fallback`
 *  (the branch checked out in the main checkout). */
export function resolveDefault(refs: RefEntry[], fallback?: string): DefaultRefs | undefined {
  const names = new Set(refs.map((r) => r.refname));
  const heads = refs.filter((r) => /^refs\/remotes\/[^/]+\/HEAD$/.test(r.refname) && r.symref);
  heads.sort((a, b) => Number(b.refname === 'refs/remotes/origin/HEAD') - Number(a.refname === 'refs/remotes/origin/HEAD'));
  const head = heads[0];
  let branch: string | undefined;
  let remote: string | undefined;
  if (head?.symref) {
    const remoteName = head.refname.split('/')[2] ?? '';
    branch = head.symref.slice(`refs/remotes/${remoteName}/`.length);
    remote = head.symref;
  } else {
    branch = ['main', 'master'].find((b) => names.has(`refs/heads/${b}`)) ?? fallback;
    if (branch && names.has(`refs/remotes/origin/${branch}`)) remote = `refs/remotes/origin/${branch}`;
  }
  if (!branch) return undefined;
  const local = names.has(`refs/heads/${branch}`) ? `refs/heads/${branch}` : undefined;
  if (!local && !remote) return undefined;
  return { branch, local, remote };
}

/** Branch names that exist on some remote. */
export function pushedBranches(refs: RefEntry[]): Set<string> {
  const out = new Set<string>();
  for (const r of refs) {
    const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec(r.refname);
    if (m?.[1] && m[1] !== 'HEAD') out.add(m[1]);
  }
  return out;
}

export interface BranchEntry {
  branch: string;
  commitAt?: number; // ms
  subject?: string;
  /** One [ahead, behind] pair per base asked for; absent when git could not compute it. */
  counts: ([number, number] | undefined)[];
}

/** Parses `for-each-ref refs/heads --format=%(refname:lstrip=2)%09%(committerdate:unix)[%09%(ahead-behind:<base>)...]%09%(subject)`.
 *  `bases` is how many ahead-behind columns the format had. The subject is last, so a tab inside it is harmless. */
export function parseBranchList(text: string, bases: number): BranchEntry[] {
  const out: BranchEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    const branch = parts[0] ?? '';
    const secs = Number(parts[1]);
    const counts: ([number, number] | undefined)[] = [];
    for (let i = 0; i < bases; i++) counts.push(parsePair(parts[2 + i] ?? ''));
    out.push({
      branch,
      commitAt: Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined,
      subject: parts.slice(2 + bases).join('\t') || undefined,
      counts,
    });
  }
  return out;
}

/** "3 7" (for-each-ref ahead-behind) or "3\t7" (rev-list --left-right --count). */
export function parsePair(text: string): [number, number] | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** Entries in `git status --porcelain` (v1): one line each, paths quoted when unusual, so lines are entries. */
export function countStatusEntries(text: string): number {
  return text.split('\n').filter((l) => l.trim() !== '').length;
}

export const STALE_DAYS = 14;

/** The group rule of the contract. readGit cannot see sessions, so it passes hasLiveSession = false; the store
 *  turns a stale item that has a live session into active. `unknown` (git could not read the worktree's status
 *  or the branch's counts) is never "merged": that group is offered for cleaning. */
export function groupOf(
  w: { isDefault: boolean; ahead: number; dirtyCount: number; lastCommitAt?: number; unknown?: boolean },
  now: number,
  hasLiveSession = false,
): WorkGroup {
  if (w.isDefault) return 'active';
  if (w.ahead === 0 && w.dirtyCount === 0) return w.unknown ? 'active' : 'merged';
  const old = w.lastCommitAt !== undefined && now - w.lastCommitAt > STALE_DAYS * 86_400_000;
  return old && !hasLiveSession ? 'stale' : 'active';
}

const GROUP_ORDER: Record<WorkGroup, number> = { active: 0, merged: 1, stale: 2 };

/** Default branch first, then active, merged, stale; newest commit first inside each. */
export function sortItems(items: WorkItem[]): WorkItem[] {
  return [...items].sort(
    (a, b) =>
      Number(b.isDefault) - Number(a.isDefault) ||
      GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
      (b.lastCommitAt ?? 0) - (a.lastCommitAt ?? 0) ||
      a.branch.localeCompare(b.branch),
  );
}

// ───────────────────────────── Locating the repository ─────────────────────────────

interface Located {
  /** Main checkout of the repository. */
  root: string;
  /** Top of the worktree `cwd` is in. */
  toplevel: string;
}

async function locate(cwd: string): Promise<Located | undefined> {
  const r = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--show-toplevel'], 5000);
  if (!r.ok) return undefined;
  const [commonDir = '', toplevel = ''] = r.stdout.split('\n');
  if (!commonDir || !toplevel) return undefined;
  // A normal repository or worktree shares <main checkout>/.git. Anything else (a submodule's .git/modules/x,
  // a bare repository) has no main checkout to point at, so the worktree itself is the project.
  const root = basename(commonDir) === '.git' ? dirname(commonDir) : toplevel;
  return { root: await real(root), toplevel: await real(toplevel) };
}

const rootCache = new Map<string, Promise<string>>();

/** The project a directory belongs to: the main checkout of its repository (a worktree resolves to the main
 *  checkout), or the directory itself outside git. Cached per directory. */
export function projectRootOf(cwd: string): Promise<string> {
  let p = rootCache.get(cwd);
  if (!p) {
    p = locate(cwd).then((l) => l?.root ?? cwd);
    rootCache.set(cwd, p);
  }
  return p;
}

async function listRefs(repoRoot: string): Promise<RefEntry[] | undefined> {
  const r = await git(repoRoot, ['for-each-ref', '--format=%(refname)%09%(symref)', 'refs/heads', 'refs/remotes']);
  return r.ok ? parseRefList(r.stdout) : undefined;
}

/** The default branch and the refs it exists as. Shared with releases.ts. */
export async function defaultRefs(repoRoot: string): Promise<DefaultRefs | undefined> {
  const [refs, head] = await Promise.all([listRefs(repoRoot), git(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD'], 3000)]);
  if (!refs) return undefined;
  return resolveDefault(refs, head.ok ? head.stdout.trim() : undefined);
}

// ───────────────────────────── readGit ─────────────────────────────

interface Counts {
  /** Per branch, against the chosen base. */
  vsBase: Map<string, [number, number]>;
  /** The default branch against its remote copy. */
  defaultVsRemote?: [number, number];
}

/** Ahead/behind of every local branch. The base is the remote's default branch when the local one is merely
 *  behind it (merged pull requests land there first), else the local default branch. One for-each-ref when
 *  git has %(ahead-behind:) (2.41+), else one rev-list per branch. */
async function branchState(repoRoot: string, def: DefaultRefs): Promise<{ branches: BranchEntry[]; counts: Counts } | undefined> {
  const bases = [def.local, def.remote].filter((b): b is string => Boolean(b));
  const cols = bases.map((b) => `%(ahead-behind:${b})`).join('%09');
  const fmt = (withCounts: boolean) => `--format=%(refname:lstrip=2)%09%(committerdate:unix)${withCounts && cols ? `%09${cols}` : ''}%09%(subject)`;

  let branches: BranchEntry[];
  const fast = await git(repoRoot, ['for-each-ref', fmt(true), 'refs/heads']);
  if (fast.ok) {
    branches = parseBranchList(fast.stdout, bases.length);
  } else {
    const plain = await git(repoRoot, ['for-each-ref', fmt(false), 'refs/heads']);
    if (!plain.ok) return undefined;
    branches = parseBranchList(plain.stdout, 0);
    await mapLimit(branches, 8, async (b) => {
      b.counts = await Promise.all(
        bases.map(async (base) => {
          const r = await git(repoRoot, ['rev-list', '--left-right', '--count', `refs/heads/${b.branch}...${base}`]);
          return r.ok ? parsePair(r.stdout) : undefined;
        }),
      );
    });
  }

  const localIdx = def.local ? 0 : -1;
  const remoteIdx = def.remote ? bases.length - 1 : -1;
  const defaultEntry = branches.find((b) => b.branch === def.branch);
  const defaultVsRemote = remoteIdx >= 0 ? defaultEntry?.counts[remoteIdx] : undefined;
  const useRemote = remoteIdx >= 0 && (localIdx < 0 || defaultVsRemote?.[0] === 0);
  const col = useRemote ? remoteIdx : localIdx;
  const vsBase = new Map<string, [number, number]>();
  for (const b of branches) {
    const c = b.counts[col];
    if (c) vsBase.set(b.branch, c);
  }
  return { branches, counts: { vsBase, defaultVsRemote } };
}

interface WorktreeStatus {
  dirtyCount: number;
  /** The directory exists but status failed (timeout, corrupt index). */
  unknown: boolean;
  /** The directory is gone. */
  missing: boolean;
}

async function worktreeStatus(w: WorktreeEntry): Promise<WorktreeStatus> {
  if (w.prunable) return { dirtyCount: 0, unknown: false, missing: true };
  const r = await git(w.path, ['status', '--porcelain', '--untracked-files=normal'], 15000);
  if (r.ok) return { dirtyCount: countStatusEntries(r.stdout), unknown: false, missing: false };
  const exists = await stat(w.path).then(
    () => true,
    () => false,
  );
  return { dirtyCount: 0, unknown: exists, missing: !exists };
}

const STATUS_CONCURRENCY = 6;

/** Worktrees and local branches of the repository the workspace is in. Items come without pr and with
 *  sessionIds: [] (the store fills both). Remote-only branches and detached worktrees are left out. */
export async function readGit(
  workspacePath: string,
  now: number,
): Promise<{ available: boolean; repoRoot?: string; defaultBranch?: string; items: WorkItem[] }> {
  const loc = await locate(workspacePath);
  if (!loc) return { available: false, items: [] };
  rootCache.set(workspacePath, Promise.resolve(loc.root));
  const repoRoot = loc.root;

  const [wtList, refs, mainHead] = await Promise.all([
    git(repoRoot, ['worktree', 'list', '--porcelain']),
    listRefs(repoRoot),
    git(repoRoot, ['symbolic-ref', '-q', '--short', 'HEAD'], 3000),
  ]);
  const worktrees = wtList.ok ? parseWorktreeList(wtList.stdout).filter((w) => !w.bare) : [];
  const def = refs ? resolveDefault(refs, mainHead.ok ? mainHead.stdout.trim() : undefined) : undefined;
  if (!refs || !def) return { available: true, repoRoot, defaultBranch: def?.branch, items: [] };
  const pushed = pushedBranches(refs);

  const withBranch = worktrees.filter((w) => w.branch);
  const [state, statuses, paths] = await Promise.all([
    branchState(repoRoot, def),
    mapLimit(withBranch, STATUS_CONCURRENCY, worktreeStatus),
    Promise.all(withBranch.map((w) => real(w.path))),
  ]);
  if (!state) return { available: true, repoRoot, defaultBranch: def.branch, items: [] };

  const byBranch = new Map<string, { path: string; status: WorktreeStatus }>();
  withBranch.forEach((w, i) => byBranch.set(w.branch as string, { path: paths[i] as string, status: statuses[i] as WorktreeStatus }));

  const items: WorkItem[] = state.branches.map((b) => {
    const isDefault = b.branch === def.branch;
    const wt = byBranch.get(b.branch);
    const status = wt?.status;
    // The default branch is measured against its remote copy; the others against the base.
    const counts = isDefault ? state.counts.defaultVsRemote : state.counts.vsBase.get(b.branch);
    const [ahead, behind] = counts ?? [0, 0];
    const dirtyCount = status?.dirtyCount ?? 0;
    const unknown = Boolean(status?.unknown) || (!isDefault && !counts);
    const item: WorkItem = {
      branch: b.branch,
      isDefault,
      isCurrent: Boolean(wt && !status?.missing && wt.path === loc.toplevel),
      group: groupOf({ isDefault, ahead, dirtyCount, lastCommitAt: b.commitAt, unknown }, now),
      dirtyCount,
      ahead,
      behind,
      pushed: pushed.has(b.branch),
      sessionIds: [],
    };
    if (wt && !status?.missing) item.worktreePath = wt.path;
    if (b.commitAt !== undefined) item.lastCommitAt = b.commitAt;
    if (b.subject !== undefined) item.lastCommitSubject = b.subject;
    return item;
  });

  return { available: true, repoRoot, defaultBranch: def.branch, items: sortItems(items) };
}

// ───────────────────────────── recentCommits ─────────────────────────────

/** Parses `git log --format=%H%x1f%ct%x1f%an%x1f%s`. */
export function parseLog(text: string, branch: string): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    const [sha = '', secs = '', author = '', ...subject] = line.split('\x1f');
    const at = Number(secs) * 1000;
    if (!sha || !Number.isFinite(at) || at <= 0) continue;
    out.push({ kind: 'commit', at, title: subject.join('\x1f'), detail: author ? `${sha.slice(0, 7)} · ${author}` : sha.slice(0, 7), branch });
  }
  return out;
}

/** The newest commits on the default branch, local and remote copies together (so commits merged on GitHub
 *  but not pulled yet show too), newest first. */
export async function recentCommits(repoRoot: string, limit: number): Promise<ActivityEvent[]> {
  const def = await defaultRefs(repoRoot);
  if (!def) return [];
  const refs = [def.local, def.remote].filter((r): r is string => Boolean(r));
  const r = await git(repoRoot, ['log', `-n${Math.max(1, Math.floor(limit))}`, '--format=%H%x1f%ct%x1f%an%x1f%s', ...refs, '--']);
  return r.ok ? parseLog(r.stdout, def.branch) : [];
}
