// What a Claude asks of Cockpit through the `cockpit` command (src/cli.ts): the request, the answer, and the words
// of `cockpit status`. Pure (no node, no vscode): actions.ts runs the request, inbox.ts carries it.
import { shipProblem } from './catchup';
import { isLinkBranch } from './data/roadmap';
import type { ItemStatus, ReleasePlan, State, WorkItem } from './model';
import { isReleaseVersion, isShipped, mergedWork, releaseStep } from './publish';

export type AgentAction =
  /** `branch`: the branch the command was run on, when it was on one: status marks it, and its own Claude (the one
   *  asking) does not count as "still working" on it. */
  | { verb: 'status'; branch?: string }
  | { verb: 'ship'; branch: string }
  | { verb: 'release'; version: string }
  | { verb: 'tag'; version: string }
  | { verb: 'pull' }
  | { verb: 'add'; lane: string; text: string }
  | { verb: 'lane'; version: string; title?: string };

/** What the command prints, a line each; `ok` false makes it exit 1. */
export interface AgentResult {
  ok: boolean;
  lines: string[];
}

export const USAGE = `Usage: cockpit <command>

  cockpit status                    what the board shows and what can be done next
  cockpit ship [branch]             finish a branch (default: the current one)
  cockpit release <version>         release a lane whose cards are all done
  cockpit tag <version>             pr delivery: tag a merged release
  cockpit pull                      pr delivery: bring the default branch up to date
  cockpit add <lane> <text…>        add a card
  cockpit lane <version> [title…]   add a release lane

Asks the Cockpit of the VS Code window open on this repository. Exit 0: done, 1: refused, 2: no Cockpit or usage.`;

const MAX_TEXT = 1000;
const MAX_NAME = 200;

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const name = (s: string): boolean => s.length > 0 && s.length <= MAX_NAME && !/[\r\n]/.test(s);
const text = (s: string): boolean => s.length > 0 && s.length <= MAX_TEXT && !/[\r\n]/.test(s);

export type ParsedArgs = { ok: true; action: AgentAction } | { ok: false; error: string };

const bad = (error: string): ParsedArgs => ({ ok: false, error });
const good = (action: AgentAction): ParsedArgs => ({ ok: true, action });

/** The command line (without `node` and the script) as a request. `currentBranch`: the branch checked out where it
 *  runs, if any; `ship` defaults to it. */
export function parseArgs(argv: string[], currentBranch?: string): ParsedArgs {
  const [verb, ...rest] = argv;
  const none = (action: AgentAction): ParsedArgs => (rest.length ? bad(`cockpit ${verb} takes no arguments.`) : good(action));
  const version = (v: string | undefined, then: (v: string) => ParsedArgs): ParsedArgs => {
    if (v === undefined) return bad(`cockpit ${verb} needs a version, like 1.2.0.`);
    return isReleaseVersion(v) ? then(v) : bad(`"${v}" is not a version, like 1.2.0.`);
  };
  switch (verb) {
    case 'status':
      return none(currentBranch && isLinkBranch(currentBranch) ? { verb: 'status', branch: currentBranch } : { verb: 'status' });
    case 'pull':
      return none({ verb: 'pull' });
    case 'ship': {
      if (rest.length > 1) return bad('cockpit ship takes one branch at most.');
      const branch = rest[0] ?? currentBranch;
      if (branch === undefined) return bad('Not on a branch here: name the one to ship, cockpit ship <branch>.');
      return isLinkBranch(branch) ? good({ verb: 'ship', branch }) : bad(`"${branch}" is not a branch name Cockpit takes.`);
    }
    case 'release':
    case 'tag':
      if (rest.length > 1) return bad(`cockpit ${verb} takes one version.`);
      return version(rest[0], (v) => good({ verb, version: v }));
    case 'add': {
      const [lane, ...words] = rest;
      const card = oneLine(words.join(' '));
      if (lane === undefined || !card) return bad('cockpit add needs a lane and the card\'s text: cockpit add Backlog "Dark mode".');
      const l = oneLine(lane);
      if (!name(l)) return bad(`The lane's name is empty or longer than ${MAX_NAME} characters.`);
      if (!text(card)) return bad(`The card's text is longer than ${MAX_TEXT} characters.`);
      return good({ verb: 'add', lane: l, text: card });
    }
    case 'lane': {
      const [v, ...words] = rest;
      const title = oneLine(words.join(' '));
      if (title && !name(title)) return bad(`The lane's title is longer than ${MAX_NAME} characters.`);
      return version(v, (x) => good(title ? { verb: 'lane', version: x, title } : { verb: 'lane', version: x }));
    }
    case undefined:
      return bad(USAGE);
    default:
      return bad(`"${verb}" is not a cockpit command.\n\n${USAGE}`);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

/** A request as read from the inbox (`raw`: the file's text), checked as strictly as the command line checks it:
 *  anything that writes to disk may have put it there. Undefined when it is not one. */
export function parseRequest(raw: string): AgentAction | undefined {
  let r: unknown;
  try {
    r = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObj(r)) return undefined;
  switch (r.verb) {
    case 'status':
      if (r.branch === undefined) return { verb: 'status' };
      return str(r.branch) && isLinkBranch(r.branch) ? { verb: 'status', branch: r.branch } : undefined;
    case 'pull':
      return { verb: 'pull' };
    case 'ship':
      return str(r.branch) && isLinkBranch(r.branch) ? { verb: 'ship', branch: r.branch } : undefined;
    case 'release':
    case 'tag':
      return str(r.version) && isReleaseVersion(r.version) ? { verb: r.verb, version: r.version } : undefined;
    case 'add':
      return str(r.lane) && name(r.lane) && str(r.text) && text(r.text) ? { verb: 'add', lane: r.lane, text: r.text } : undefined;
    case 'lane': {
      if (!str(r.version) || !isReleaseVersion(r.version)) return undefined;
      if (r.title === undefined) return { verb: 'lane', version: r.version };
      return str(r.title) && name(r.title) ? { verb: 'lane', version: r.version, title: r.title } : undefined;
    }
    default:
      return undefined;
  }
}

// ───────────────────────────── cockpit status ─────────────────────────────

const MARK: Record<ItemStatus, string> = { todo: '[ ]', doing: '[~]', done: '[x]' };

/** Why the branch cannot ship, from the point of view of the Claude asking on `current`: its own session is not
 *  "a Claude still working" there. */
function problemFor(item: WorkItem, state: State, current: string | undefined): string | undefined {
  return shipProblem(item.branch === current ? { ...item, sessionIds: [] } : item, state);
}

function laneHeader(lane: ReleasePlan): string {
  const done = lane.items.filter((i) => i.status === 'done').length;
  const parts = [lane.backlog ? lane.version : `${lane.version}${lane.title ? ` · ${lane.title}` : ''}`];
  if (lane.status) parts.push(`(${lane.status})`);
  if (!lane.backlog && lane.items.length) parts.push(`${done} of ${lane.items.length} done`);
  return parts.join('  ');
}

/** The lane's next step as a line, and the command for it when there is one. */
function laneNext(lane: ReleasePlan, state: State): { line?: string; command?: string } {
  const step = releaseStep(lane, state);
  const direct = state.work.delivery === 'direct';
  if (step?.step === 'release') {
    const command = `cockpit release ${lane.version}`;
    return { line: `next: ${command}  (${direct ? `commits Release ${lane.version} on ${state.work.defaultBranch ?? 'the default branch'} and tags v${lane.version}` : 'opens the release pull request'})`, command };
  }
  if (step?.step === 'review') return { line: `next: release pull request #${step.pr.number} is open, merge it on GitHub (${step.pr.url})` };
  if (step?.step === 'tag') {
    const command = `cockpit tag ${lane.version}`;
    return { line: `next: ${command}`, command };
  }
  if (!lane.backlog && isReleaseVersion(lane.version) && lane.items.some((i) => i.status !== 'done')) {
    const open = lane.items.filter((i) => i.status !== 'done').length;
    return { line: `next: ${open} card${open === 1 ? '' : 's'} to finish before it can be released` };
  }
  return {};
}

/** `cockpit status`: the delivery mode and the board file, each lane with its cards and next step, each branch with
 *  work on it and whether it can ship, and the command to run next. `current`: the branch the command ran on. */
export function statusLines(state: State, current?: string): string[] {
  const { work, releases } = state;
  const base = work.defaultBranch ?? 'the default branch';
  const out: string[] = [];
  const next: string[] = [];

  out.push(`Cockpit: ${state.workspace?.name ?? work.repoRoot ?? 'this window'}`);
  if (work.available) {
    out.push(
      work.delivery === 'direct'
        ? `Delivery: direct: ship merges into ${base} here${work.hasOrigin ? ' and pushes it' : ''}; release commits and tags on ${base}.`
        : `Delivery: pull requests${work.github ? ` on ${work.github}` : ''}: ship pushes the branch and opens its pull request.`,
    );
  }
  out.push(
    releases.roadmapExists
      ? `Board: ${releases.roadmapName ?? releases.roadmapPath ?? 'the roadmap'}`
      : `Board: none yet${releases.roadmapName ? ` (${releases.roadmapName})` : ''}: cockpit add Backlog <text> or cockpit lane <version> starts it.`,
  );

  // The board.
  for (const lane of releases.roadmap) {
    out.push('');
    if (isShipped(lane, state)) {
      out.push(`${lane.version}${lane.title ? ` · ${lane.title}` : ''}  shipped`);
      continue;
    }
    out.push(laneHeader(lane));
    if (!lane.items.length) out.push('  (no cards)');
    for (const i of lane.items) out.push(`  ${MARK[i.status]} ${i.text}${i.branch ? `  <${i.branch}>` : ''}`);
    const { line, command } = laneNext(lane, state);
    if (line) out.push(`  ${line}`);
    if (command) next.push(command);
  }

  // The branches with work on them.
  const branches = work.items.filter((i) => !i.isDefault && (i.ahead > 0 || i.dirtyCount > 0));
  if (branches.length) {
    out.push('', 'Branches');
    for (const item of branches) {
      const problem = problemFor(item, state, current);
      const here = item.branch === current ? ' (here)' : '';
      const counts = `${item.ahead} ahead${item.dirtyCount ? `, ${item.dirtyCount} uncommitted` : ''}`;
      out.push(`  ${item.branch}${here}  ${counts}`);
      if (problem) out.push(`    cannot ship: ${problem}`);
      else {
        const command = item.branch === current ? 'cockpit ship' : `cockpit ship ${item.branch}`;
        out.push(`    ready to ship: ${command}`);
        // The branch the command ran on comes first: it is the one its Claude is asking about.
        if (item.branch === current) next.unshift(command);
        else next.push(command);
      }
    }
  }

  // What merged on GitHub but is not pulled yet.
  if (work.delivery === 'pr') {
    const merged = mergedWork(releases.roadmap);
    if (merged.branches.length || merged.versions.length) next.push('cockpit pull');
  }

  out.push('', next[0] ? `Next: ${next[0]}` : 'Next: nothing to ship or release right now.');
  return out;
}

