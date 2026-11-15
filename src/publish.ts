// What Ship and Release send out, as text: pull request titles and bodies, commit messages, the version bump, the
// dated changelog heading, and where a release lane stands. Pure, so every word that leaves the machine is
// unit-tested; src/ship.ts runs the commands. Kept free of `vscode` and node modules: the webview imports
// releaseStep.
import type { ReleasePlan, State, PullRequest } from './model';

/** A card as a pull request names it: its text and its lane. */
export interface ShippedCard {
  text: string;
  lane: string;
}

const TITLE_MAX = 72;
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** The cards, joined, when they fit a title; else the first and how many more. With no card, `fallback` (the last
 *  commit's subject, or the branch). */
export function prTitle(cards: ShippedCard[], fallback: string): string {
  const texts = cards.map((c) => oneLine(c.text));
  const first = texts[0];
  if (first === undefined) return cut(oneLine(fallback), TITLE_MAX);
  const joined = texts.join('; ');
  if (joined.length <= TITLE_MAX) return joined;
  if (texts.length === 1) return cut(first, TITLE_MAX);
  const more = ` (+${texts.length - 1} more)`;
  return `${cut(first, TITLE_MAX - more.length)}${more}`;
}

/** The cards it finishes, then the report of the Claude that did the work. */
export function prBody(cards: ShippedCard[], report: string | undefined): string {
  const parts: string[] = [];
  if (cards.length) parts.push(['Roadmap:', '', ...cards.map((c) => `- [x] ${oneLine(c.text)} (${c.lane})`)].join('\n'));
  if (report?.trim()) parts.push(`## Report\n\n${report.trim()}`);
  return parts.join('\n\n');
}

/** The message of the commit that carries ROADMAP.md on the branch. */
export function roadmapCommitMessage(cards: ShippedCard[]): string {
  const first = cards[0];
  if (!first) return 'Roadmap: the board as it is on the main checkout';
  if (cards.length === 1) return cut(`Roadmap: ${oneLine(first.text)} done`, TITLE_MAX);
  return `Roadmap: ${cards.length} cards done`;
}

// ───────────────────────────── Release ─────────────────────────────

export const releaseBranch = (version: string): string => `release-${version}`;
export const releaseTitle = (version: string): string => `Release ${version}`;
export const tagName = (version: string): string => `v${version}`;
/** A version Release takes: "1.2.0", "1.2.0-rc.1". */
export const isReleaseVersion = (v: string): boolean => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/.test(v) && !v.includes('..');

export function releaseBody(lane: ReleasePlan, notes: string[]): string {
  const parts: string[] = [];
  if (notes.length) parts.push(['## Changelog', '', ...notes.map((n) => `- ${oneLine(n)}`)].join('\n'));
  if (lane.items.length) parts.push(['## Roadmap', '', ...lane.items.map((i) => `- [x] ${oneLine(i.text)}`)].join('\n'));
  return parts.join('\n\n');
}

export type TextEdit = { ok: true; text: string } | { ok: false; error: string };

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The file with its version moved from `from` to `to`, at the first place it holds it: a JSON file's first
 *  "version" key with that value, any other file's first `from` standing alone (not part of a longer version or word). */
export function bumpVersion(file: string, text: string, from: string, to: string): TextEdit {
  const json = file.endsWith('.json');
  const re = json ? new RegExp(String.raw`("version"\s*:\s*")${escape(from)}(")`) : new RegExp(String.raw`(^|[^\w.-])${escape(from)}(?![\w.-])`, 'm');
  if (!re.test(text)) return { ok: false, error: `${file} does not hold the version ${from}.` };
  return { ok: true, text: text.replace(re, json ? `$1${to}$2` : `$1${to}`) };
}

/** CHANGELOG.md with what was under "## Unreleased" (or "## [Unreleased]") under a new "## X.Y.Z - YYYY-MM-DD" (or
 *  "## [X.Y.Z] - YYYY-MM-DD") heading, which releases.ts reads back as that release and its date, and an empty
 *  Unreleased section left above it. */
export function datedChangelog(text: string, version: string, date: string): TextEdit {
  const lines = text.split(/\r?\n/);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  let fence = false;
  let at = -1;
  for (const [i, line] of lines.entries()) {
    if (/^ {0,3}(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    if (new RegExp(String.raw`^##\s*\[?v?${escape(version)}\]?(\s|$)`).test(line)) return { ok: false, error: `CHANGELOG.md already has ${version}.` };
    if (at < 0 && /^##\s*\[?unreleased\]?\s*$/i.test(line)) at = i;
  }
  const heading = lines[at];
  if (heading === undefined) return { ok: false, error: 'CHANGELOG.md has no "## Unreleased" section to release.' };
  // The heading as it was stays on top, empty, for what comes after this release.
  lines.splice(at, 1, heading, '', heading.includes('[') ? `## [${version}] - ${date}` : `## ${version} - ${date}`);
  return { ok: true, text: lines.join(eol) };
}

/** "1.2.0" against "1.10.0": by number, a pre-release before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core = '', pre] = v.replace(/^v/, '').split('-', 2);
    return { nums: core.split('.').map((n) => Number(n) || 0), pre };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** What merged on GitHub and still reads as open in ROADMAP.md: branches with linked cards whose pull request merged,
 *  and releases whose release pull request merged while their lane is not "shipped". The host then makes the main
 *  checkout's ROADMAP.md read as the merged one does, so the pull after the merge leaves it clean. */
export function mergedWork(state: State): { branches: string[]; versions: string[] } {
  const merged = new Set(state.work.items.filter((i) => !i.isDefault && i.pr?.state === 'merged').map((i) => i.branch));
  const lanes = state.releases.roadmap;
  const branches = [...new Set(lanes.flatMap((l) => l.items.flatMap((i) => (i.branch && merged.has(i.branch) ? [i.branch] : []))))];
  const versions = lanes.filter((l) => !l.backlog && !/\b(shipped|released)\b/i.test(l.status ?? '') && merged.has(releaseBranch(l.version))).map((l) => l.version);
  return { branches, versions };
}

/** Where a release lane stands, from the board and what git and GitHub show:
 *  - release: every card is done; its release pull request can be prepared;
 *  - review: the release pull request is open;
 *  - tag: it merged (or the lane says "shipped") and no tag at or after its version exists yet.
 *  Nothing for the backlog, an empty lane, a lane with open cards, or one already tagged. */
export type ReleaseStep = { step: 'release' } | { step: 'review'; pr: PullRequest } | { step: 'tag' };

export function releaseStep(lane: ReleasePlan, state: State): ReleaseStep | undefined {
  if (lane.backlog || lane.items.length === 0 || !isReleaseVersion(lane.version)) return undefined;
  const latest = state.releases.latestTag;
  if (latest && compareVersions(latest, lane.version) >= 0) return undefined;
  const pr = state.work.items.find((i) => i.branch === releaseBranch(lane.version))?.pr;
  if (pr?.state === 'merged' || /\b(shipped|released)\b/i.test(lane.status ?? '')) return { step: 'tag' };
  if (pr?.state === 'open') return { step: 'review', pr };
  return lane.items.every((i) => i.status === 'done') ? { step: 'release' } : undefined;
}
