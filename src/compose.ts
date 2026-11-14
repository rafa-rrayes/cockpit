// Builds the State from what the adapters read. Pure: no I/O, no clock (the caller passes `now`), so the store,
// scripts/dump-state.ts and the tests all get the same State from the same inputs.
import type {
  ActivityEvent,
  Attention,
  CiRun,
  ClaudeSession,
  Project,
  PullRequest,
  Releases,
  State,
  WorkItem,
} from './model';
import { sortItems } from './data/git';

export interface GitResult {
  available: boolean;
  repoRoot?: string;
  defaultBranch?: string;
  items: WorkItem[];
}

export interface GithubResult {
  github?: string;
  githubNote?: string;
  prs: PullRequest[];
  ciRuns: CiRun[];
}

export interface ComposeInput {
  now: number;
  workspace?: { name: string; path: string };
  /** The project the workspace folder belongs to (projectRootOf of its path). */
  workspaceProjectKey?: string;
  sessions: ClaudeSession[];
  git?: GitResult;
  github?: GithubResult;
  releases?: Releases;
  /** Recent commits on the default branch (git.ts recentCommits). */
  commits?: ActivityEvent[];
}

const ACTIVITY_LIMIT = 60;

const lastSegment = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** `path` is `dir` or inside it (either separator, so Windows paths work too). */
function within(path: string, dir: string): boolean {
  if (!path.startsWith(dir)) return false;
  const next = path.charAt(dir.length);
  return next === '' || next === '/' || next === '\\' || dir.endsWith('/') || dir.endsWith('\\');
}

const byRecency = (a: ClaudeSession, b: ClaudeSession): number =>
  Number(b.live) - Number(a.live) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.sessionId.localeCompare(b.sessionId);

// ───────────────────────────── Projects ─────────────────────────────

/** Sessions grouped by projectKey. The workspace's project comes first (even with no sessions, so the UI can say
 *  so), then projects with a live session, then the rest; by latest activity inside each tier. */
export function buildProjects(sessions: ClaudeSession[], workspaceProjectKey?: string): Project[] {
  const groups = new Map<string, ClaudeSession[]>();
  if (workspaceProjectKey) groups.set(workspaceProjectKey, []);
  for (const s of sessions) {
    const list = groups.get(s.projectKey);
    if (list) list.push(s);
    else groups.set(s.projectKey, [s]);
  }
  const projects = [...groups].map(([key, list]) => {
    list.sort(byRecency);
    return {
      project: { key, name: lastSegment(key), isWorkspace: key === workspaceProjectKey, sessionIds: list.map((s) => s.sessionId) },
      live: list.some((s) => s.live),
      latest: Math.max(0, ...list.map((s) => s.updatedAt ?? 0)),
    };
  });
  projects.sort(
    (a, b) =>
      Number(b.project.isWorkspace) - Number(a.project.isWorkspace) ||
      Number(b.live) - Number(a.live) ||
      b.latest - a.latest ||
      a.project.name.localeCompare(b.project.name),
  );
  return projects.map((p) => p.project);
}

// ───────────────────────────── Work items ─────────────────────────────

/** The work item a session belongs to: the worktree its cwd is in (the deepest one, because agent worktrees often
 *  live inside the main checkout). A session that only matches the main checkout belongs to the branch checked out
 *  there, unless its transcript names another branch: then it is that branch when the branch lost its worktree
 *  (removed by hand), and nothing otherwise (it ran on a branch that is gone, or before a checkout switched).
 *  A session whose folder is unknown belongs nowhere. */
export function itemForSession(s: ClaudeSession, items: WorkItem[], repoRoot: string | undefined): WorkItem | undefined {
  if (!s.cwd) return undefined;
  let best: WorkItem | undefined;
  for (const item of items) {
    if (!item.worktreePath || !within(s.cwd, item.worktreePath)) continue;
    if (!best || (best.worktreePath?.length ?? 0) < item.worktreePath.length) best = item;
  }
  const main = repoRoot ? items.find((i) => i.worktreePath === repoRoot) : undefined;
  if (best && best !== main) return best;
  // Inside the main checkout by path, or nothing by path (a symlinked cwd): only if the session is of this project,
  // and not of another repository nested in the main checkout.
  if (!repoRoot || s.projectKey !== repoRoot) return undefined;
  if (!s.gitBranch || s.gitBranch === main?.branch) return main;
  return items.find((i) => i.branch === s.gitBranch && !i.worktreePath);
}

/** The PR of a branch: the open one when there is one, else the most recently updated. */
function prFor(branch: string, prs: PullRequest[]): PullRequest | undefined {
  const mine = prs.filter((p) => p.branch === branch);
  return mine.find((p) => p.state === 'open') ?? [...mine].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
}

/** Worktree folder names (agent-<id>) of the subagents still running in live sessions: Claude Code isolates such
 *  an agent in <root>/.claude/worktrees/agent-<id>, while the session's own cwd stays in the main checkout. */
export function runningAgentWorktrees(sessions: ClaudeSession[]): Set<string> {
  const out = new Set<string>();
  for (const s of sessions) if (s.live) for (const a of s.subagents) if (!a.finished) out.add(`agent-${a.id}`);
  return out;
}

/** The worktree is the isolation worktree of a running subagent. */
export function isRunningAgentWorktree(item: WorkItem, running: Set<string>): boolean {
  return item.worktreePath !== undefined && running.has(lastSegment(item.worktreePath));
}

/** Items with their PR and sessions, regrouped now that sessions are known:
 *  - an item with a live session, or a running subagent's worktree, is active: a Claude is working there even
 *    before its first edit (readGit cannot see sessions, so it calls a fresh clean branch merged or stale);
 *  - a clean branch whose PR was merged and that has no commit after the PR's last update is merged, though it is
 *    "ahead": a squash or rebase merge leaves the branch's own commits out of the default branch. */
export function buildItems(git: GitResult, sessions: ClaudeSession[], prs: PullRequest[]): WorkItem[] {
  const items = git.items.map((i): WorkItem => ({ ...i, sessionIds: [] }));
  const running = runningAgentWorktrees(sessions);
  const byItem = new Map<WorkItem, ClaudeSession[]>();
  for (const s of [...sessions].sort(byRecency)) {
    const item = itemForSession(s, items, git.repoRoot);
    if (!item) continue;
    const list = byItem.get(item);
    if (list) list.push(s);
    else byItem.set(item, [s]);
  }
  for (const item of items) {
    const own = byItem.get(item) ?? [];
    item.sessionIds = own.map((s) => s.sessionId);
    const pr = prFor(item.branch, prs);
    if (pr && !item.isDefault) item.pr = pr;
    const live = own.some((s) => s.live) || isRunningAgentWorktree(item, running);
    if (live) item.group = 'active';
    const squashMerged =
      pr?.state === 'merged' &&
      item.ahead > 0 &&
      item.dirtyCount === 0 &&
      !live &&
      item.lastCommitAt !== undefined &&
      pr.updatedAt !== undefined &&
      item.lastCommitAt <= pr.updatedAt;
    if (!item.isDefault && squashMerged) item.group = 'merged';
  }
  return sortItems(items);
}

// ───────────────────────────── Needs you ─────────────────────────────

/** For each workflow, its newest run on the branch. */
function latestRunsPerWorkflow(runs: CiRun[], branch: string): CiRun[] {
  const latest = new Map<string, CiRun>();
  for (const r of runs) {
    if (r.branch !== branch) continue;
    const prev = latest.get(r.workflow);
    if (!prev || (r.startedAt ?? 0) > (prev.startedAt ?? 0)) latest.set(r.workflow, r);
  }
  return [...latest.values()];
}

export function buildAttention(sessions: ClaudeSession[], projects: Project[], github: GithubResult | undefined, defaultBranch: string | undefined): Attention[] {
  const projectName = new Map(projects.map((p) => [p.key, p.name]));
  const out: Attention[] = [];
  for (const s of [...sessions].sort(byRecency)) {
    if (s.status !== 'waiting') continue;
    const where = projectName.get(s.projectKey);
    const why = s.waitingFor ? `Waiting: ${s.waitingFor}` : 'Waiting for you';
    out.push({ kind: 'session_waiting', title: s.title, detail: where ? `${why} · ${where}` : why, sessionId: s.sessionId, at: s.updatedAt });
  }
  if (github && defaultBranch) {
    for (const r of latestRunsPerWorkflow(github.ciRuns, defaultBranch)) {
      if (r.status !== 'failure') continue;
      out.push({ kind: 'ci_failed', title: `${r.workflow || 'CI'} failed on ${defaultBranch}`, detail: r.title, url: r.url, at: r.startedAt });
    }
  }
  for (const p of github?.prs ?? []) {
    if (p.state !== 'open' || p.reviewDecision !== 'changes_requested') continue;
    out.push({ kind: 'pr_changes_requested', title: `#${p.number} ${p.title}`, detail: p.branch, url: p.url, at: p.updatedAt });
  }
  return out;
}

// ───────────────────────────── Activity ─────────────────────────────

const CI_WORDS: Record<CiRun['status'], string> = {
  success: 'passed',
  failure: 'failed',
  in_progress: 'running',
  queued: 'queued',
  cancelled: 'cancelled',
  other: 'finished',
};

const PR_WORDS: Record<PullRequest['state'], string> = { open: 'open', merged: 'merged', closed: 'closed' };

export function buildActivity(sessions: ClaudeSession[], projects: Project[], github: GithubResult | undefined, commits: ActivityEvent[]): ActivityEvent[] {
  const projectName = new Map(projects.map((p) => [p.key, p.name]));
  const out: ActivityEvent[] = [...commits];
  for (const s of sessions) {
    const base = { title: s.title, sessionId: s.sessionId, detail: projectName.get(s.projectKey), branch: s.gitBranch };
    if (s.startedAt) out.push({ kind: 'session_started', at: s.startedAt, ...base });
    if (!s.live && s.updatedAt) out.push({ kind: 'session_ended', at: s.updatedAt, ...base });
  }
  for (const r of github?.ciRuns ?? []) {
    if (!r.startedAt) continue;
    out.push({ kind: 'ci', at: r.startedAt, title: `${r.workflow || 'CI'} ${CI_WORDS[r.status]}`, detail: r.title || undefined, url: r.url, branch: r.branch || undefined });
  }
  for (const p of github?.prs ?? []) {
    if (!p.updatedAt) continue;
    const state = p.state === 'open' && p.isDraft ? 'draft' : PR_WORDS[p.state];
    out.push({ kind: 'pr', at: p.updatedAt, title: `#${p.number} ${p.title}`, detail: state, url: p.url, branch: p.branch });
  }
  return out.sort((a, b) => b.at - a.at).slice(0, ACTIVITY_LIMIT);
}

// ───────────────────────────── State ─────────────────────────────

const noReleases = (): Releases => ({ available: false, roadmap: [], changelog: [] });

export function compose(input: ComposeInput): State {
  const { sessions, git, github } = input;
  const projects = buildProjects(sessions, input.workspaceProjectKey);
  const items = git?.available ? buildItems(git, sessions, github?.prs ?? []) : [];
  const state: State = {
    generatedAt: input.now,
    attention: buildAttention(sessions, projects, github, git?.defaultBranch),
    sessions: Object.fromEntries(sessions.map((s) => [s.sessionId, s])),
    projects,
    work: {
      available: git?.available ?? false,
      items,
      ciRuns: github?.ciRuns ?? [],
    },
    releases: input.releases ?? noReleases(),
    activity: buildActivity(sessions, projects, github, input.commits ?? []),
  };
  if (input.workspace) state.workspace = input.workspace;
  if (git?.repoRoot) state.work.repoRoot = git.repoRoot;
  if (git?.defaultBranch) state.work.defaultBranch = git.defaultBranch;
  if (github?.github) state.work.github = github.github;
  if (github?.githubNote) state.work.githubNote = github.githubNote;
  return state;
}
