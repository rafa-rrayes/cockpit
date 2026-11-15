// The roadmap board's file (.cockpit/roadmap.md or ROADMAP.md, see cockpitDir.ts): the parser the board reads and
// the edits the board makes. Pure (no node, no vscode), so the webview's browser preview runs the same code.
//
// House format (read tolerantly: anything else is skipped, never an error):
//   ## 1.2.0 — Comunidade             a release: version (optional "v" or [brackets]), "—", "-" or ":", an optional title
//   Target: week of 2026-11-16        optional, free text
//   Status: in progress               optional, free text ("planned", "in progress", "shipped")
//   - [ ] Comments                    to do (a plain "- Comments" too)
//   - [~] Video feed                  in progress (also "[/]" and "[-]")
//   - [x] Seasons                     done
//   - [~] Feed <!-- cockpit:worktree-1.2.0-feed -->
//                                     the branch working on the card, recorded by Start Claude, dropped by the Pull
//                                     after its merge;
//                                     the comment is not part of the card's text and every edit keeps it
//   - [ ] Feed <!-- cockpit:who=Rafa --> <!-- cockpit:time=2h -->
//                                     the member the card is assigned to and how long it takes, set from the board;
//                                     kept by every edit like the link, before it on the line
//   ## Backlog                       work not yet in a release (also "Later", "Unscheduled", "Someday", "Ideas")
//   Other headings ("## Notes", "## 1. Foundations": a version has a dot or a "v") end the lane above and are
//   skipped with their items. Lines inside ``` or ~~~ code fences are skipped. "*" and "+" bullets, nested items
//   and "### sub-headings" inside a lane are accepted (the sub-heading itself is skipped).
//
// Edits change only the lines they touch: every other byte of the file stays as it was.
import type { ItemStatus, ReleasePlan, RoadmapEdit } from '../model';

// "1.2", "1.2.0-rc.1", "v2"; not a bare number, which is how numbered section headings start.
export const VERSION = String.raw`(?:v(?=\d)|(?=\d+\.\d))(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)`;
const ROADMAP_HEADING = new RegExp(String.raw`^\[?${VERSION}\]?\s*(?:[—–:-]\s*)?(.*)$`);
const BACKLOG_HEADING = /^(backlog|later|unscheduled|someday|ideas)$/i;
const ITEM = /^(\s*)([-*+]|\d+[.)])(\s+)(?:\[([ xX~/-])\]\s*)?(.*)$/;
const NEW_VERSION = /^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?$/;
const MAX_TEXT = 300;
/** One of Cockpit's comments at the end of a card's line: a branch link, "who=<name>" or "time=<duration>". */
const META = /\s*<!--\s*cockpit:([^>]*?)\s*-->\s*$/;
const ANY_LINK = /<!--\s*cockpit:[^>]*-->/g;
/** What a branch name may be inside a link: what git allows, minus anything that could close the comment. */
export const isLinkBranch = (b: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b) && !b.includes('..') && b.length <= 200;

export const MAX_MEMBER_NAME = 40;
/** What a member's name may be: letters, digits, spaces and a few marks, nothing that could close a comment. */
export const isMemberName = (n: unknown): n is string =>
  typeof n === 'string' && n.length <= MAX_MEMBER_NAME && /^[\p{L}\p{N}](?:[\p{L}\p{N} ._'-]*[\p{L}\p{N}._'])?$/u.test(n) && !n.includes('--');

const UNITS: Record<string, string> = { m: 'm', min: 'm', mins: 'm', minute: 'm', minutes: 'm', h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h', d: 'd', day: 'd', days: 'd', w: 'w', wk: 'w', week: 'w', weeks: 'w' };

/** "2 hours" → "2h", "1h 30min" → "1h30m", "3" → "3h"; undefined for anything that is not a duration. */
export function normalizeDuration(input: string): string | undefined {
  const s = input.trim().toLowerCase();
  if (!s || s.length > 30) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s) > 0 ? `${Number(s)}h` : undefined;
  const parts = [...s.matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)\s*/g)];
  if (parts.map((p) => p[0]).join('') !== s) return undefined;
  let out = '';
  let total = 0;
  for (const [, n, unit] of parts) {
    const u = UNITS[unit ?? ''];
    if (!u) return undefined;
    total += Number(n);
    out += `${Number(n)}${u}`;
  }
  return total > 0 ? out : undefined;
}

interface Meta {
  branch?: string;
  who?: string;
  duration?: string;
}

/** A card's text and what Cockpit's comments at the end of its line say. A comment it does not know stays in the
 *  text, with whatever comes before it. */
function splitMeta(body: string): Meta & { text: string } {
  let text = body;
  const meta: Meta = {};
  for (let m = META.exec(text); m; m = META.exec(text)) {
    const value = m[1] ?? '';
    const kv = /^(who|time)=(.*)$/.exec(value);
    if (kv?.[1] === 'who' && isMemberName(kv[2])) meta.who ??= kv[2];
    else if (kv?.[1] === 'time' && normalizeDuration(kv[2] ?? '')) meta.duration ??= normalizeDuration(kv[2] ?? '');
    else if (!kv && isLinkBranch(value)) meta.branch ??= value;
    else break;
    text = text.slice(0, m.index);
  }
  return { text, ...meta };
}

/** The comments for what `meta` says, in the order Cockpit writes them: who, time, then the branch link. */
const metaComments = (meta: Meta): string =>
  (meta.who ? ` <!-- cockpit:who=${meta.who} -->` : '') + (meta.duration ? ` <!-- cockpit:time=${meta.duration} -->` : '') + (meta.branch ? ` <!-- cockpit:${meta.branch} -->` : '');

const boxOf: Record<ItemStatus, string> = { todo: ' ', doing: '~', done: 'x' };
const statusOf = (box: string | undefined): ItemStatus => (box === undefined || box === ' ' ? 'todo' : box === 'x' || box === 'X' ? 'done' : 'doing');

/** Strips bold/italic markers around a "Key:" label: "**Target:** x" → "Target: x". */
const unwrapLabel = (line: string) => line.replace(/^([*_]{1,2})(\w+:)\1/, '$2').replace(/^([*_]{1,2})(\w+)\1:/, '$2:');

// FNV-1a: short, stable, good enough to tell "this is still the line I read" from "it changed".
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

interface ItemAt {
  line: number;
  hash: string;
}

interface Lane {
  plan: ReleasePlan;
  heading: number;
  /** One past the lane's last line: the next "#" or "##" heading, or the end of the file. */
  end: number;
  items: ItemAt[];
}

interface Scan {
  lines: string[];
  eol: string;
  lanes: Lane[];
}

function scan(text: string): Scan {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const lanes: Lane[] = [];
  let cur: Lane | undefined;
  let fence: string | undefined;
  for (const [i, raw] of lines.entries()) {
    // A fence closes with the same character, at least as many times.
    const f = /^ {0,3}(`{3,}|~{3,})/.exec(raw);
    if (fence) {
      if (f?.[1] && f[1][0] === fence[0] && f[1].length >= fence.length && raw.trim() === f[1]) fence = undefined;
      continue;
    }
    if (f?.[1]) {
      fence = f[1];
      continue;
    }
    const h = /^(#{1,2})(?!#)\s*(.*?)\s*#*\s*$/.exec(raw);
    if (h) {
      if (cur) cur.end = i;
      cur = undefined;
      const name = h[2] ?? '';
      const m = h[1] === '##' ? ROADMAP_HEADING.exec(name) : null;
      if (m?.[1]) {
        cur = { plan: { version: m[1], items: [] }, heading: i, end: lines.length, items: [] };
        if (m[2]?.trim()) cur.plan.title = m[2].trim();
      } else if (h[1] === '##' && BACKLOG_HEADING.test(name)) {
        cur = { plan: { version: name, backlog: true, items: [] }, heading: i, end: lines.length, items: [] };
      }
      if (cur) lanes.push(cur);
      continue;
    }
    if (!cur || /^#/.test(raw)) continue;
    const item = ITEM.exec(raw);
    if (item) {
      const { text, ...meta } = splitMeta((item[5] ?? '').trim());
      const body = text.trim();
      if (!body) continue;
      const at = { line: i, hash: hash(raw) };
      cur.items.push(at);
      cur.plan.items.push({ id: `${at.line}:${at.hash}`, text: body, status: statusOf(item[4]), ...meta });
      continue;
    }
    const field = /^(target|status)\s*:\s*(.+)$/i.exec(unwrapLabel(raw.trim()));
    if (field?.[1] && field[2]) {
      const value = field[2].trim();
      if (field[1].toLowerCase() === 'target') cur.plan.target ??= value;
      else cur.plan.status ??= value;
    }
  }
  return { lines, eol, lanes };
}

export function parseRoadmap(text: string): ReleasePlan[] {
  return scan(text).lanes.map((l) => l.plan);
}

// ───────────────────────────── Edits ─────────────────────────────

export type EditResult = { ok: true; text: string } | { ok: false; error: string };

const STALE = 'The roadmap changed since the board last read it. Try again.';
const fail = (error: string): EditResult => ({ ok: false, error });

/** One line, trimmed and bounded: a card is a single list item. A link typed into the text is dropped: only Cockpit
 *  writes links. */
const clean = (text: string): string => text.replace(ANY_LINK, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);

const sameLane = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The item an id names: the same line with the same content, or, when lines moved, the only line with that
 *  content. Anything else means the file changed in a way the edit cannot follow. */
function locate(doc: Scan, id: string): { lane: Lane; at: ItemAt } | undefined {
  const sep = id.indexOf(':');
  const line = Number(id.slice(0, sep));
  const h = id.slice(sep + 1);
  const all = doc.lanes.flatMap((lane) => lane.items.map((at) => ({ lane, at })));
  const exact = all.find((x) => x.at.line === line && x.at.hash === h);
  if (exact) return exact;
  const same = all.filter((x) => x.at.hash === h);
  return same.length === 1 ? same[0] : undefined;
}

/** An item's lines: its own, and the lines of wrapped text under it (indented deeper, not list items). */
function blockLength(doc: Scan, lane: Lane, line: number): number {
  const indent = ITEM.exec(doc.lines[line] ?? '')?.[1]?.length ?? 0;
  let n = 1;
  for (let i = line + 1; i < lane.end; i++) {
    const next = doc.lines[i] ?? '';
    const lead = /^\s*/.exec(next)?.[0].length ?? 0;
    if (!next.trim() || lead <= indent || ITEM.test(next)) break;
    n++;
  }
  return n;
}

/** Where a new item goes at the end of a lane, and the lines to put there: after its last item, or after its
 *  last line of text with a blank line between. */
function appendTo(doc: Scan, lane: Lane, block: string[]): { at: number; lines: string[] } {
  const last = lane.items.at(-1);
  if (last) return { at: last.line + blockLength(doc, lane, last.line), lines: block };
  let text = lane.heading;
  for (let i = lane.heading + 1; i < lane.end; i++) if ((doc.lines[i] ?? '').trim()) text = i;
  const next = doc.lines[text + 1];
  return { at: text + 1, lines: ['', ...block, ...(next !== undefined && next.trim() ? [''] : [])] };
}

/** A new "## heading" at `at`, with a blank line on each side. */
function insertHeading(lines: string[], at: number, heading: string): void {
  const before = at > 0 && (lines[at - 1] ?? '').trim() ? [''] : [];
  const after = lines[at] !== undefined && (lines[at] ?? '').trim() ? [''] : [];
  lines.splice(at, 0, ...before, heading, ...after);
}

/** The index after the last line with text: where a section is added at the end, before trailing blank lines. */
function endOfText(lines: string[]): number {
  let at = lines.length;
  while (at > 0 && !(lines[at - 1] ?? '').trim()) at--;
  return at;
}

/** The lane, creating "## Backlog" at the end of the file when that is the one asked for and it is missing. */
function laneOf(doc: Scan, name: string): { doc: Scan; lane: Lane } | undefined {
  const found = doc.lanes.find((l) => sameLane(l.plan.version, name));
  if (found) return { doc, lane: found };
  if (!BACKLOG_HEADING.test(name)) return undefined;
  const lines = doc.lines.slice();
  insertHeading(lines, endOfText(lines), '## Backlog');
  const next = scan(lines.join(doc.eol));
  const lane = next.lanes.find((l) => l.plan.backlog && sameLane(l.plan.version, 'Backlog'));
  return lane ? { doc: next, lane } : undefined;
}

const done = (doc: Scan, lines: string[]): EditResult => ({ ok: true, text: lines.join(doc.eol) });

/** What a rewrite changes: each one given is set, null drops it, absent keeps it as it was. */
interface Change {
  status?: ItemStatus;
  text?: string;
  indent?: string;
  branch?: string | null;
  who?: string | null;
  duration?: string | null;
}

/** The item line with what `change` names changed and the rest as it was, Cockpit's comments included. */
function rewrite(raw: string, change: Change): string {
  const m = ITEM.exec(raw);
  if (!m) return raw;
  const indent = change.indent ?? m[1] ?? '';
  const box = change.status ? boxOf[change.status] : m[4];
  let rest = m[5] ?? '';
  if (change.text !== undefined || change.branch !== undefined || change.who !== undefined || change.duration !== undefined) {
    const cur = splitMeta(rest);
    const pick = (next: string | null | undefined, old: string | undefined): string | undefined => (next === null ? undefined : (next ?? old));
    rest =
      (change.text ?? cur.text) +
      metaComments({ who: pick(change.who, cur.who), duration: pick(change.duration, cur.duration), branch: pick(change.branch, cur.branch) });
  }
  return `${indent}${m[2]}${m[3]}${box === undefined ? '' : `[${box}] `}${rest}`;
}

/** The text of the roadmap after `edit`, or why it cannot be made. `create` is not an edit of a text: see
 *  starterRoadmap. */
export function applyRoadmapEdit(text: string, edit: RoadmapEdit): EditResult {
  const doc = scan(text);
  switch (edit.op) {
    case 'create':
      return fail('The roadmap already exists.');

    case 'add': {
      const body = clean(edit.text);
      if (!body) return fail('A card needs some text.');
      const target = laneOf(doc, edit.lane);
      if (!target) return fail(`The roadmap has no "${edit.lane}" section any more.`);
      const lines = target.doc.lines.slice();
      const spot = appendTo(target.doc, target.lane, [`- [ ] ${body}`]);
      lines.splice(spot.at, 0, ...spot.lines);
      return done(target.doc, lines);
    }

    case 'setText':
    case 'setStatus': {
      const found = locate(doc, edit.id);
      if (!found) return fail(STALE);
      const change = edit.op === 'setText' ? { text: clean(edit.text) } : { status: edit.status };
      if (change.text === '') return fail('A card needs some text.');
      const lines = doc.lines.slice();
      lines[found.at.line] = rewrite(lines[found.at.line] ?? '', change);
      return done(doc, lines);
    }

    case 'assign':
    case 'setDuration': {
      const found = locate(doc, edit.id);
      if (!found) return fail(STALE);
      let change: Change;
      if (edit.op === 'assign') {
        if (edit.who !== undefined && !isMemberName(edit.who)) return fail(`"${edit.who}" cannot be written into the roadmap.`);
        change = { who: edit.who ?? null };
      } else {
        const duration = edit.duration === undefined ? null : normalizeDuration(edit.duration);
        if (duration === undefined) return fail('A duration looks like 30m, 2h, 1d or 1h30m.');
        change = { duration };
      }
      const lines = doc.lines.slice();
      lines[found.at.line] = rewrite(lines[found.at.line] ?? '', change);
      return done(doc, lines);
    }

    case 'remove': {
      const found = locate(doc, edit.id);
      if (!found) return fail(STALE);
      const lines = doc.lines.slice();
      lines.splice(found.at.line, blockLength(doc, found.lane, found.at.line));
      return done(doc, lines);
    }

    case 'move': {
      const found = locate(doc, edit.id);
      if (!found) return fail(STALE);
      const before = edit.before === undefined ? undefined : locate(doc, edit.before);
      if (edit.before !== undefined && !before) return fail(STALE);
      // Dropped on itself: only the status can have changed.
      if (before && before.at.line === found.at.line) return applyRoadmapEdit(text, { op: 'setStatus', id: edit.id, status: edit.status });

      // Take the item out, then read the file again: every line number after it moved.
      const length = blockLength(doc, found.lane, found.at.line);
      const lines = doc.lines.slice();
      const block = lines.splice(found.at.line, length);
      const target = laneOf(scan(lines.join(doc.eol)), edit.lane);
      if (!target) return fail(`The roadmap has no "${edit.lane}" section any more.`);
      const out = target.doc.lines.slice();

      if (before) {
        const line = before.at.line > found.at.line ? before.at.line - length : before.at.line;
        if (!target.lane.items.some((i) => i.line === line)) return fail(STALE);
        const indent = ITEM.exec(out[line] ?? '')?.[1] ?? '';
        block[0] = rewrite(block[0] ?? '', { status: edit.status, indent });
        out.splice(line, 0, ...block);
      } else {
        // A nested item that leaves its parent becomes a top-level one.
        block[0] = rewrite(block[0] ?? '', { status: edit.status, indent: '' });
        const spot = appendTo(target.doc, target.lane, block);
        out.splice(spot.at, 0, ...spot.lines);
      }
      return done(target.doc, out);
    }

    case 'addRelease': {
      const version = edit.version.trim().replace(/^v/i, '');
      if (!NEW_VERSION.test(version)) return fail('A release needs a version like 1.2.0.');
      if (doc.lanes.some((l) => !l.plan.backlog && l.plan.version === version)) return fail(`The roadmap already has ${version}.`);
      const title = clean(edit.title ?? '');
      const lines = doc.lines.slice();
      // Releases stay above the backlog.
      const backlog = doc.lanes.find((l) => l.plan.backlog);
      insertHeading(lines, backlog ? backlog.heading : endOfText(lines), `## ${version}${title ? ` — ${title}` : ''}`);
      return done(doc, lines);
    }
  }
}

// ───────────────────────────── Branch links and shipping ─────────────────────────────
// Not edits the webview can ask for: the host makes them when it starts a Claude, ships a branch, pulls what merged
// or prepares a release.

/** Links the card to `branch` (replacing any link it had), moving it to `status` too when one is given. */
export function linkCard(text: string, id: string, branch: string, status?: ItemStatus): EditResult {
  if (!isLinkBranch(branch)) return fail(`"${branch}" cannot be written into the roadmap.`);
  const doc = scan(text);
  const found = locate(doc, id);
  if (!found) return fail(STALE);
  const lines = doc.lines.slice();
  lines[found.at.line] = rewrite(lines[found.at.line] ?? '', { branch, ...(status ? { status } : {}) });
  return done(doc, lines);
}

/** The text with every card linked to `branch` done and unlinked: what the board reads once the branch merged.
 *  The same text when no card is linked to it. */
export function finishBranch(text: string, branch: string): string {
  const doc = scan(text);
  const lines = doc.lines.slice();
  for (const lane of doc.lanes) {
    for (const at of lane.items) {
      const raw = lines[at.line] ?? '';
      if (splitMeta((ITEM.exec(raw)?.[5] ?? '').trim()).branch === branch) lines[at.line] = rewrite(raw, { status: 'done', branch: null });
    }
  }
  return lines.join(doc.eol);
}

/** Branches whose pull request merged and releases whose release pull request merged (publish.ts mergedWork). */
export interface MergedWork {
  branches: string[];
  versions: string[];
}

/** The text as the merges have it: every card of the merged branches done and unlinked, and the merged releases
 *  shipped. That is what the board reads after them. */
export function finishMerged(text: string, work: MergedWork): string {
  let out = text;
  for (const b of work.branches) out = finishBranch(out, b);
  for (const v of work.versions) {
    const r = setLaneStatus(out, v, 'shipped');
    if (r.ok) out = r.text;
  }
  return out;
}

/** The release's "Status:" set to `value`: the line it has rewritten, or one added under its heading (after a
 *  "Target:" line right there). */
export function setLaneStatus(text: string, version: string, value: string): EditResult {
  const doc = scan(text);
  const lane = doc.lanes.find((l) => !l.plan.backlog && l.plan.version === version);
  if (!lane) return fail(`The roadmap has no "${version}" section any more.`);
  const lines = doc.lines.slice();
  const items = new Set(lane.items.map((i) => i.line));
  for (let i = lane.heading + 1; i < lane.end; i++) {
    const raw = lines[i] ?? '';
    if (items.has(i) || !/^status\s*:/i.test(unwrapLabel(raw.trim()))) continue;
    // After the colon, and after the bold or italic markers closing a "**Status:**" label.
    lines[i] = raw.replace(/:(\s*(?:[*_]{1,2}\s*)?).*$/, `:$1${value}`);
    return done(doc, lines);
  }
  let at = lane.heading + 1;
  if (/^target\s*:/i.test(unwrapLabel((lines[at] ?? '').trim()))) at++;
  lines.splice(at, 0, `Status: ${value}`);
  return done(doc, lines);
}

/** "1.1.0" → "1.2.0": the release a new roadmap starts with. */
export function nextMinor(version?: string): string {
  const m = /^(\d+)\.(\d+)/.exec(version ?? '');
  return m ? `${m[1]}.${Number(m[2]) + 1}.0` : '0.1.0';
}

export const starterRoadmap = (currentVersion?: string): string => `# Roadmap\n\n## ${nextMinor(currentVersion)}\n\n## Backlog\n`;
