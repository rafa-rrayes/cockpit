// GitHub adapter: pull requests and CI runs through the gh CLI, on the person's existing login.
// gh missing, logged out, no GitHub remote or offline: never throws; the lists it could not read are left out,
// with a short githubNote (the store then keeps the last lists it had).
import type { CheckSummary, CiJob, CiRun, PullRequest } from '../model';
import { run, type RunResult } from './git';

const PR_FIELDS = 'number,title,url,headRefName,isDraft,state,reviewDecision,statusCheckRollup,updatedAt';
const RUN_FIELDS = 'databaseId,displayTitle,workflowName,headBranch,status,conclusion,url,startedAt,createdAt,updatedAt';
const PR_LIMIT = 40;
const RUN_LIMIT = 10;

// No prompts, no update banners, no colour codes in what we parse.
const GH_ENV = { GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_SPINNER_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' };

/** gh in `cwd`, without a shell, prompts or colours. Shared with ship.ts, which publishes through it. */
export const runGh = (cwd: string, args: string[], timeoutMs = 20000) => run('gh', args, { cwd, timeoutMs, env: GH_ENV });
const gh = runGh;

// ───────────────────────────── Pure parsers ─────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
/** ISO time to epoch ms; GitHub writes 0001-01-01T00:00:00Z for "not yet". */
const time = (v: unknown): number | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) && t > 0 ? t : undefined;
};

function parseArray(json: string): unknown[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED', 'ERROR']);

/** One state for a PR's statusCheckRollup: any failure wins, then anything still running, then success. */
export function summarizeChecks(rollup: unknown): CheckSummary {
  const checks = Array.isArray(rollup) ? rollup.filter(isObj) : [];
  if (checks.length === 0) return { state: 'none' };
  let pending: string | undefined;
  let anyPending = false;
  let firstUrl: string | undefined;
  for (const c of checks) {
    const url = str(c.detailsUrl) ?? str(c.targetUrl);
    firstUrl ??= url;
    // CheckRun: status + conclusion. StatusContext: state.
    const outcome = (str(c.conclusion) ?? str(c.state) ?? '').toUpperCase();
    const status = (str(c.status) ?? '').toUpperCase();
    if (FAILED.has(outcome)) return url ? { state: 'failure', url } : { state: 'failure' };
    const running = c.__typename === 'StatusContext' ? outcome === 'PENDING' || outcome === 'EXPECTED' : status !== '' && status !== 'COMPLETED';
    if (running) {
      anyPending = true;
      pending ??= url;
    }
  }
  const url = anyPending ? pending : firstUrl;
  const state = anyPending ? 'pending' : 'success';
  return url ? { state, url } : { state };
}

const PR_STATES: Record<string, PullRequest['state']> = { OPEN: 'open', MERGED: 'merged', CLOSED: 'closed' };
const REVIEWS: Record<string, NonNullable<PullRequest['reviewDecision']>> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes_requested',
  REVIEW_REQUIRED: 'review_required',
};

/** Parses `gh pr list --json <PR_FIELDS>`. Entries without a number or branch are dropped. */
export function parsePullRequests(json: string): PullRequest[] {
  const out: PullRequest[] = [];
  for (const p of parseArray(json)) {
    if (!isObj(p) || typeof p.number !== 'number' || !str(p.headRefName)) continue;
    const pr: PullRequest = {
      number: p.number,
      title: str(p.title) ?? `#${p.number}`,
      url: str(p.url) ?? '',
      branch: str(p.headRefName) as string,
      isDraft: p.isDraft === true,
      state: PR_STATES[String(p.state).toUpperCase()] ?? 'open',
      checks: summarizeChecks(p.statusCheckRollup),
    };
    const review = REVIEWS[String(p.reviewDecision).toUpperCase()];
    if (review) pr.reviewDecision = review;
    const updatedAt = time(p.updatedAt);
    if (updatedAt) pr.updatedAt = updatedAt;
    out.push(pr);
  }
  return out;
}

export function runStatus(status: string | undefined, conclusion: string | undefined): CiRun['status'] {
  switch ((status ?? '').toLowerCase()) {
    case 'in_progress':
      return 'in_progress';
    case 'queued':
    case 'waiting':
    case 'requested':
    case 'pending':
      return 'queued';
    case 'completed':
      break;
    default:
      return 'other';
  }
  switch ((conclusion ?? '').toLowerCase()) {
    case 'success':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'startup_failure':
      return 'failure';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'other'; // skipped, neutral, stale, action_required
  }
}

/** Parses `gh run list --json <RUN_FIELDS>`, newest first, at most RUN_LIMIT. */
export function parseRuns(json: string): CiRun[] {
  const out: CiRun[] = [];
  for (const r of parseArray(json)) {
    if (!isObj(r) || typeof r.databaseId !== 'number') continue;
    const status = runStatus(str(r.status), str(r.conclusion));
    const startedAt = time(r.startedAt) ?? time(r.createdAt);
    const updatedAt = time(r.updatedAt);
    const ci: CiRun = {
      id: r.databaseId,
      title: str(r.displayTitle) ?? '',
      workflow: str(r.workflowName) ?? '',
      branch: str(r.headBranch) ?? '',
      status,
      url: str(r.url) ?? '',
    };
    if (startedAt) ci.startedAt = startedAt;
    const finished = status !== 'in_progress' && status !== 'queued';
    if (finished && startedAt && updatedAt && updatedAt >= startedAt) ci.durationMs = updatedAt - startedAt;
    out.push(ci);
  }
  out.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return out.slice(0, RUN_LIMIT);
}

/** Parses `gh run view <id> --json jobs`: the jobs in the order GitHub lists them. */
export function parseJobs(json: string): CiJob[] {
  let list: unknown;
  try {
    const v: unknown = JSON.parse(json);
    list = isObj(v) ? v.jobs : undefined;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: CiJob[] = [];
  for (const j of list) {
    const name = isObj(j) ? str(j.name) : undefined;
    if (!isObj(j) || !name) continue;
    const skipped = String(j.conclusion).toLowerCase() === 'skipped';
    const job: CiJob = { name, status: skipped ? 'skipped' : runStatus(str(j.status), str(j.conclusion)) };
    const url = str(j.url);
    if (url) job.url = url;
    const startedAt = time(j.startedAt);
    const completedAt = time(j.completedAt);
    if (startedAt) job.startedAt = startedAt;
    if (startedAt && completedAt && completedAt >= startedAt) job.durationMs = completedAt - startedAt;
    out.push(job);
  }
  return out;
}

/** A few words on why gh gave nothing. */
export function ghNote(r: Pick<RunResult, 'stderr' | 'code' | 'timedOut'>): string {
  const err = r.stderr;
  if (r.code === 'ENOENT') return 'gh not installed';
  if (r.timedOut) return 'GitHub unreachable (timed out)';
  // Checked before "logged out": this message also suggests `gh auth login`.
  if (/no git remotes found|known GitHub host/i.test(err)) return 'no GitHub remote';
  if (/not a git repository/i.test(err)) return 'not a git repository';
  if (r.code === 4 || /gh auth login|not logged in|authentication/i.test(err)) return 'gh not logged in';
  if (/dial tcp|connection refused|no such host|could not resolve|network is unreachable|i\/o timeout|TLS handshake/i.test(err)) {
    return 'GitHub unreachable (offline?)';
  }
  const first = err.split('\n').find((l) => l.trim() !== '')?.trim() ?? `exit ${String(r.code ?? '?')}`;
  return `gh failed: ${first.length > 80 ? `${first.slice(0, 79)}…` : first}`;
}

// ───────────────────────────── readGithub ─────────────────────────────

export interface GithubRead {
  github?: string;
  githubNote?: string;
  /** Absent when gh could not list them (as opposed to an empty list). */
  prs?: PullRequest[];
  ciRuns?: CiRun[];
}

/** The repository's GitHub name, its recent pull requests (open, merged and closed, newest first as gh lists
 *  them) and its latest CI runs. The three gh calls run together. */
export async function readGithub(repoRoot: string): Promise<GithubRead> {
  const [repo, prs, runs] = await Promise.all([
    gh(repoRoot, ['repo', 'view', '--json', 'nameWithOwner']),
    gh(repoRoot, ['pr', 'list', '--state', 'all', '--limit', String(PR_LIMIT), '--json', PR_FIELDS]),
    gh(repoRoot, ['run', 'list', '--limit', String(RUN_LIMIT), '--json', RUN_FIELDS]),
  ]);
  if (!repo.ok) return { githubNote: ghNote(repo) };

  let github: string | undefined;
  try {
    const v: unknown = JSON.parse(repo.stdout);
    if (isObj(v)) github = str(v.nameWithOwner);
  } catch {
    // Unparseable output leaves github unset; the lists below may still be good.
  }
  const failed = [prs, runs].find((r) => !r.ok);
  const out: GithubRead = {};
  if (github) out.github = github;
  if (prs.ok) out.prs = parsePullRequests(prs.stdout);
  if (runs.ok) {
    out.ciRuns = parseRuns(runs.stdout);
    // The jobs of the runs going on now, so the page can show where each one is.
    await Promise.all(
      out.ciRuns
        .filter((r) => r.status === 'in_progress' || r.status === 'queued')
        .map(async (r) => {
          const view = await gh(repoRoot, ['run', 'view', String(r.id), '--json', 'jobs']);
          if (view.ok) r.jobs = parseJobs(view.stdout);
        }),
    );
  }
  if (failed) out.githubNote = ghNote(failed);
  return out;
}
