// Catch up: what changed since the person last looked, each with the one thing to do next. Worked out from the State
// alone (transcripts, git and the gh data Cockpit already has), so the webview shows it and the tests check it
// without the host. Kept free of `vscode` and node modules.
import type { CatchUpMark, ClaudeSession, PrMark, PullRequest, RoadmapItem, State, WorkItem } from './model';

/** The one next action of an entry. ship: push the branch and open its PR. pull: bring the main checkout up to date
 *  after a merge. open: the session's details. */
export type NextAction = 'ship' | 'resume' | 'focus' | 'open' | 'openPr' | 'pull';

export type CatchUpEntry =
  | {
      kind: 'session';
      at: number;
      session: ClaudeSession;
      /** The branch it worked on, when it is one of this repository's. */
      item?: WorkItem;
      /** The roadmap cards linked to that branch. */
      cards: RoadmapItem[];
      action: NextAction;
    }
  | { kind: 'pr'; at: number; pr: PullRequest; change: 'passed' | 'failed' | 'merged'; cards: RoadmapItem[]; action: NextAction };

/** With no mark yet (Catch up never closed in this workspace), the last day counts as new. */
export const FIRST_LOOK_MS = 86_400_000;

/** A pull request as a mark remembers it. */
export const prMark = (pr: PullRequest): PrMark => (pr.state === 'open' ? pr.checks.state : pr.state);

/** What Catch up saw when it was closed at `now`: the pull requests as they are in the State. */
export function markOf(state: State, now: number): CatchUpMark {
  const prs: Record<string, PrMark> = {};
  for (const item of state.work.items) if (item.pr) prs[String(item.pr.number)] = prMark(item.pr);
  return { at: now, prs };
}

const MARKS = new Set<string>(['merged', 'closed', 'success', 'failure', 'pending', 'none']);

/** A mark as stored in the workspace state, or undefined when it is not one. */
export function parseMark(raw: unknown): CatchUpMark | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { at, prs } = raw as Record<string, unknown>;
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof prs !== 'object' || prs === null) return undefined;
  const out: Record<string, PrMark> = {};
  for (const [k, v] of Object.entries(prs)) if (/^\d+$/.test(k) && typeof v === 'string' && MARKS.has(v)) out[k] = v as PrMark;
  return { at, prs: out };
}

/** The cards ROADMAP.md links to `branch`. */
export function cardsOf(state: State, branch: string): RoadmapItem[] {
  return state.releases.roadmap.flatMap((lane) => lane.items.filter((i) => i.branch === branch));
}

/** The lane new cards from a branch's report go to: the lane of its first linked card, else the backlog. */
export function laneOf(state: State, branch: string | undefined): string {
  if (branch) for (const lane of state.releases.roadmap) if (lane.items.some((i) => i.branch === branch)) return lane.version;
  return state.releases.roadmap.find((l) => l.backlog)?.version ?? 'Backlog';
}

/** Why the branch cannot ship, or undefined when it is ready: commits the default branch lacks, nothing uncommitted,
 *  no pull request open or merged, no Claude working or waiting in it; in `pr` delivery GitHub at hand, in `direct`
 *  the main checkout on the default branch (the merge happens there). `self`: the one asking is the Claude working
 *  on the branch (`cockpit ship`), so a Claude in it does not count as busy. */
export function shipProblem(item: WorkItem, state: State, opts: { self?: boolean } = {}): string | undefined {
  const base = state.work.defaultBranch ?? 'the default branch';
  const busy = item.sessionIds.some((id) => {
    const s = state.sessions[id];
    return s !== undefined && s.live && s.status !== 'idle' && s.status !== 'ended';
  });
  if (item.isDefault) return `${item.branch} is the default branch.`;
  if (item.dirtyCount > 0) return `${item.branch} has ${item.dirtyCount} uncommitted file${item.dirtyCount === 1 ? '' : 's'}: commit them, or resume its agent, first.`;
  if (item.ahead === 0) return `${item.branch} has no commits that ${base} lacks.`;
  if (item.pr && item.pr.state !== 'closed') return `${item.branch} already has pull request #${item.pr.number} (${item.pr.state}).`;
  if (busy && !opts.self) return `An agent is still working on ${item.branch}.`;
  if (state.work.delivery === 'direct') {
    if (!canPull(state)) return `The main checkout${state.work.repoRoot ? ` (${state.work.repoRoot})` : ''} is not on ${base}: ${item.branch} is merged into ${base} there.`;
  } else if (!state.work.github) {
    return `GitHub is not available here${state.work.githubNote ? ` (${state.work.githubNote})` : ''}: Cockpit publishes through gh.`;
  }
  return undefined;
}

export const canShip = (item: WorkItem, state: State): boolean => shipProblem(item, state) === undefined;

/** The default branch is checked out in the main checkout: a pull there brings in what merged. */
const canPull = (state: State): boolean => state.work.items.some((i) => i.isDefault && i.worktreePath !== undefined && i.worktreePath === state.work.repoRoot);

function sessionAction(s: ClaudeSession, item: WorkItem | undefined, state: State): NextAction {
  const here = s.live && s.inVsCodeTerminal === true;
  if (s.status === 'waiting') return here ? 'focus' : 'open';
  if (item && item.dirtyCount > 0 && item.worktreePath !== state.work.repoRoot) return here ? 'focus' : s.live || s.canResume === false ? 'open' : 'resume';
  if (item?.pr?.state === 'open') return 'openPr';
  if (item && canShip(item, state)) return 'ship';
  return 'open';
}

/** The actions that leave work unfinished while they are not taken. */
const PENDING = new Set<NextAction>(['ship', 'resume', 'focus']);

const CHANGES: Partial<Record<PrMark, 'passed' | 'failed' | 'merged'>> = { success: 'passed', failure: 'failed', merged: 'merged' };

/** What changed since the mark, newest first:
 *  - this project's sessions that finished (idle or ended) or wait for the person, since the mark, the newest one
 *    per branch, with the branch's cards; and older ones whose next action is still to take (a branch to ship,
 *    uncommitted work to resume), however long ago they were seen;
 *  - pull requests whose checks turned green or red, or that merged, since the mark (a pull request the mark does not
 *    know counts when it was updated after it). */
export function catchUp(state: State): CatchUpEntry[] {
  const mark = state.caughtUp;
  const since = mark?.at ?? state.generatedAt - FIRST_LOOK_MS;
  const project = state.projects.find((p) => p.isWorkspace);
  const itemOf = new Map<string, WorkItem>();
  for (const item of state.work.items) for (const id of item.sessionIds) itemOf.set(id, item);

  const out: CatchUpEntry[] = [];
  const sessions = (project?.sessionIds ?? [])
    .map((id) => state.sessions[id])
    .filter((s): s is ClaudeSession => s !== undefined && (s.status === 'idle' || s.status === 'ended' || s.status === 'waiting'))
    // Seen is not done: one that still has something to do (ship, resume, answer) stays until it is done.
    .filter((s) => (s.updatedAt ?? 0) > since || PENDING.has(sessionAction(s, itemOf.get(s.sessionId), state)))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const seen = new Set<WorkItem>();
  for (const session of sessions) {
    const item = itemOf.get(session.sessionId);
    if (item) {
      if (seen.has(item)) continue;
      seen.add(item);
    }
    const cards = item && !item.isDefault ? cardsOf(state, item.branch) : [];
    out.push({ kind: 'session', at: session.updatedAt ?? since, session, ...(item ? { item } : {}), cards, action: sessionAction(session, item, state) });
  }

  for (const item of state.work.items) {
    const pr = item.pr;
    if (!pr) continue;
    const now = prMark(pr);
    const before = mark?.prs[String(pr.number)];
    const change = CHANGES[now];
    if (!change || (before === undefined ? (pr.updatedAt ?? 0) <= since : before === now)) continue;
    const action: NextAction = change === 'merged' && canPull(state) ? 'pull' : 'openPr';
    out.push({ kind: 'pr', at: pr.updatedAt ?? state.generatedAt, pr, change, cards: cardsOf(state, item.branch), action });
  }
  return out.sort((a, b) => b.at - a.at);
}

// ───────────────────────────── What a report leaves open ─────────────────────────────

// Headings a report puts its open ends under: "Still open", "Left open", "Open items", "Not done", "Follow-ups"...
const OPEN_HEADING = /\b(?:still|left)\s+open\b|\bopen\s+(?:items|questions|points|issues|ends)\b|\bleft\s+to\s+do\b|\bnot\s+(?:yet\s+)?done\b|\bfollow[- ]?ups?\b|\bremaining\b|\bto-?dos?\b/i;
const LIST = /^(\s*)(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;
const NOTHING = /^(?:none|nothing|n\/a|no(?:thing)? open\b)/i;

/** A line that reads as a heading: "## Still open", "**Still open:**", "Still open:". */
function headingText(line: string): string | undefined {
  const t = line.trim();
  const md = /^#{1,6}\s+(.*)$/.exec(t);
  if (md) return md[1];
  const bold = /^(\*\*|__)(.+?)\1:?$/.exec(t);
  if (bold) return bold[2];
  if (t.length <= 80 && t.endsWith(':') && !LIST.test(t)) return t;
  return undefined;
}

/** Plain card text from a list item: markdown emphasis and code marks dropped. */
const plain = (s: string): string =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** The items listed under a "still open" style heading of a report, as card texts. None when the report has no such
 *  part, or when the part is a sentence rather than a list: nothing is guessed. */
export function stillOpen(report: string | undefined): string[] {
  if (!report) return [];
  const lines = report.split(/\r?\n/);
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const heading = fence ? undefined : headingText(line);
    if (!heading || !OPEN_HEADING.test(heading)) continue;
    // The list right under it: blank lines allowed before it, wrapped and nested lines joined to their item.
    let indent: number | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j] ?? '';
      if (!next.trim()) {
        if (indent === undefined) continue;
        const after = lines[j + 1] ?? '';
        if (LIST.test(after) && (LIST.exec(after)?.[1]?.length ?? 0) === indent) continue;
        break;
      }
      const m = LIST.exec(next);
      const lead = /^\s*/.exec(next)?.[0].length ?? 0;
      if (m && (indent === undefined || lead === indent)) {
        indent ??= lead;
        out.push(m[2] ?? '');
      } else if (indent !== undefined && lead > indent && out.length > 0) {
        out[out.length - 1] += ` ${m ? (m[2] ?? '') : next}`;
      } else break;
      i = j;
    }
  }
  return [...new Set(out.map(plain).filter((t) => t && !NOTHING.test(t)))];
}
