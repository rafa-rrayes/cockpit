// Releases adapter: the current version, the latest v* tag, ROADMAP.md and CHANGELOG.md.
//
// House format (both files are read tolerantly: anything else is skipped, never an error):
//
// ROADMAP.md
//   ## 1.2.0 — Comunidade             a release: version (optional "v" or [brackets]), "—", "-" or ":", an optional title
//   Target: week of 2026-11-16        optional, free text
//   Status: in progress               optional, free text ("planned", "in progress", "shipped")
//   - [ ] Seasons                     not done
//   - [x] Video feed                  done
//   - Comments                        a plain item counts as not done
//   Headings that do not start with a version ("## Later", "## 1. Foundations": a version has a dot or a "v")
//   are skipped with their items. Lines inside ``` or ~~~ code fences are skipped in both files. "*" and "+" bullets,
//   nested items and "### sub-headings" inside a release are accepted (the sub-heading itself is skipped).
//
// CHANGELOG.md
//   ## Unreleased                     also "## [Unreleased]"
//   ## 1.2.0 - 2026-11-20             also "## [1.2.0] - 2026-11-20", "## v1.2.0 (2026-11-20)", "## 1.2.0"
//   ### Added                         sub-headings are skipped, their items kept
//   - A line                          every list item is one line; an indented continuation joins the item above
//   Kept in file order (newest first by convention), Unreleased moved to the top, at most 5 entries.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChangelogEntry, ReleasePlan, Releases } from '../model';
import { defaultRefs, runGit as git } from './git';

// ───────────────────────────── Pure parsers ─────────────────────────────

// "1.2", "1.2.0-rc.1", "v2"; not a bare number, which is how numbered section headings start.
const VERSION = String.raw`(?:v(?=\d)|(?=\d+\.\d))(\d+(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)`;
const ROADMAP_HEADING = new RegExp(String.raw`^\[?${VERSION}\]?\s*(?:[—–:-]\s*)?(.*)$`);
const CHANGELOG_HEADING = new RegExp(String.raw`^\[?${VERSION}\]?\s*(.*)$`);
const LIST_ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s*(.*)$/;

/** Lines outside fenced code blocks: a fence closes with the same character, at least as many times. */
function* outsideFences(text: string): Generator<string> {
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m?.[1] && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = undefined;
      continue;
    }
    if (m?.[1]) {
      fence = m[1];
      continue;
    }
    yield line;
  }
}

/** Strips bold/italic markers around a "Key:" label: "**Target:** x" → "Target: x". */
const unwrapLabel = (line: string) => line.replace(/^([*_]{1,2})(\w+:)\1/, '$2').replace(/^([*_]{1,2})(\w+)\1:/, '$2:');

export function parseRoadmap(text: string): ReleasePlan[] {
  const out: ReleasePlan[] = [];
  let cur: ReleasePlan | undefined;
  for (const raw of outsideFences(text)) {
    const h2 = /^##(?!#)\s*(.*?)\s*#*\s*$/.exec(raw);
    if (h2) {
      const m = ROADMAP_HEADING.exec(h2[1] ?? '');
      cur = m?.[1] ? { version: m[1], items: [] } : undefined;
      if (cur && m?.[2]?.trim()) cur.title = m[2].trim();
      if (cur) out.push(cur);
      continue;
    }
    if (!cur || /^#/.test(raw)) continue;
    const item = LIST_ITEM.exec(raw);
    if (item) {
      const body = (item[2] ?? '').trim();
      const box = CHECKBOX.exec(body);
      const text = (box ? box[2] ?? '' : body).trim();
      if (text) cur.items.push({ text, done: box ? box[1] !== ' ' : false });
      continue;
    }
    const field = /^(target|status)\s*:\s*(.+)$/i.exec(unwrapLabel(raw.trim()));
    if (field?.[1] && field[2]) {
      const value = field[2].trim();
      if (field[1].toLowerCase() === 'target') cur.target ??= value;
      else cur.status ??= value;
    }
  }
  return out;
}

export function parseChangelog(text: string, limit = 5): ChangelogEntry[] {
  const all: ChangelogEntry[] = [];
  let cur: ChangelogEntry | undefined;
  let lastWasItem = false;
  for (const raw of outsideFences(text)) {
    const h2 = /^##(?!#)\s*(.*?)\s*#*\s*$/.exec(raw);
    if (h2) {
      cur = changelogHeading(h2[1] ?? '');
      if (cur) all.push(cur);
      lastWasItem = false;
      continue;
    }
    if (!cur) continue;
    if (/^#/.test(raw) || raw.trim() === '') {
      lastWasItem = false;
      continue;
    }
    const item = LIST_ITEM.exec(raw);
    if (item) {
      const body = (item[2] ?? '').trim();
      if (body) {
        cur.lines.push(body);
        lastWasItem = true;
      }
      continue;
    }
    if (lastWasItem && /^\s+\S/.test(raw) && cur.lines.length > 0) {
      cur.lines[cur.lines.length - 1] += ` ${raw.trim()}`;
    }
  }
  const unreleased = all.filter((e) => e.version === 'Unreleased');
  const released = all.filter((e) => e.version !== 'Unreleased');
  return [...unreleased.slice(0, 1), ...released].slice(0, limit);
}

function changelogHeading(heading: string): ChangelogEntry | undefined {
  if (/^\[?unreleased\]?/i.test(heading)) return { version: 'Unreleased', lines: [] };
  const m = CHANGELOG_HEADING.exec(heading);
  if (!m?.[1]) return undefined;
  const entry: ChangelogEntry = { version: m[1], lines: [] };
  const rest = (m[2] ?? '').trim();
  const iso = /\d{4}-\d{2}-\d{2}/.exec(rest);
  const date = iso ? iso[0] : rest.replace(/^[—–:-]\s*/, '').replace(/^\((.*)\)$/, '$1').trim();
  if (date) entry.date = date;
  return entry;
}

/** The version in one manifest's text, or undefined when it has none. */
export function versionFrom(file: string, text: string): string | undefined {
  if (file.endsWith('.json')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      return undefined;
    }
    if (typeof v !== 'object' || v === null) return undefined;
    const obj = v as Record<string, unknown>;
    // app.json is Expo's: the version sits under "expo".
    const holder = file.endsWith('app.json') && obj.expo !== undefined ? obj.expo : obj;
    const version = typeof holder === 'object' && holder !== null ? (holder as Record<string, unknown>).version : undefined;
    return typeof version === 'string' && version.trim() ? version.trim() : undefined;
  }
  const sections = file === 'Cargo.toml' ? ['package', 'workspace.package'] : ['project', 'tool.poetry'];
  return tomlVersion(text, sections);
}

/** `version = "…"` inside one of the given [sections]: just enough TOML for a manifest. */
function tomlVersion(text: string, sections: string[]): string | undefined {
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = (header[1] ?? '').trim();
      continue;
    }
    if (!sections.includes(section)) continue;
    const m = /^version\s*=\s*["']([^"']+)["']$/.exec(line);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

/** Parses `git tag --list v* --sort=-v:refname --format=%(refname:short)%09%(creatordate:unix)`: the first
 *  tag that looks like a version. */
export function parseLatestTag(text: string): { tag: string; at?: number } | undefined {
  for (const line of text.split('\n')) {
    const [tag = '', secs = ''] = line.split('\t');
    if (!/^v\d/.test(tag)) continue;
    const at = Number(secs) * 1000;
    return Number.isFinite(at) && at > 0 ? { tag, at } : { tag };
  }
  return undefined;
}

// ───────────────────────────── readReleases ─────────────────────────────

export const VERSION_SOURCES = ['package.json', 'app.json', 'app/app.json', 'pyproject.toml', 'Cargo.toml'];

const readText = (path: string) => readFile(path, 'utf8').catch(() => undefined);

/** Manifests, ROADMAP.md and CHANGELOG.md from `dir` (the worktree open, whose files may be ahead of the main
 *  checkout's); tags and commit counts from `repoRoot`. */
export async function readReleases(dir: string, repoRoot = dir): Promise<Releases> {
  const [manifests, roadmapText, changelogText, tags] = await Promise.all([
    Promise.all(VERSION_SOURCES.map((f) => readText(join(dir, f)))),
    readText(join(dir, 'ROADMAP.md')),
    readText(join(dir, 'CHANGELOG.md')),
    // versionsort.suffix=- sorts v1.2.0-rc1 before v1.2.0.
    git(repoRoot, ['-c', 'versionsort.suffix=-', 'tag', '--list', 'v*', '--sort=-v:refname', '--format=%(refname:short)%09%(creatordate:unix)']),
  ]);

  const out: Releases = {
    available: false,
    roadmap: roadmapText ? parseRoadmap(roadmapText) : [],
    changelog: changelogText ? parseChangelog(changelogText) : [],
  };
  for (const [i, file] of VERSION_SOURCES.entries()) {
    const text = manifests[i];
    const version = text ? versionFrom(file, text) : undefined;
    if (version) {
      out.currentVersion = version;
      out.versionSource = file;
      break;
    }
  }

  const latest = tags.ok ? parseLatestTag(tags.stdout) : undefined;
  if (latest) {
    out.latestTag = latest.tag;
    if (latest.at) out.latestTagAt = latest.at;
    // Counted on the default branch, local and remote copies together, so a pull not done yet doesn't hide commits.
    const def = await defaultRefs(repoRoot);
    const heads = def ? [def.local, def.remote].filter((r): r is string => Boolean(r)) : ['HEAD'];
    const count = await git(repoRoot, ['rev-list', '--count', `^refs/tags/${latest.tag}`, ...heads, '--']);
    const n = Number(count.stdout.trim());
    if (count.ok && Number.isFinite(n)) out.commitsSinceTag = n;
  }

  out.available = Boolean(out.currentVersion || out.latestTag || roadmapText !== undefined || changelogText !== undefined);
  return out;
}
