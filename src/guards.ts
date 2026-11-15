// The checks behind actions.ts, kept free of `vscode` so they are unit-tested: what the webview may ask for,
// and what "Clean merged" may remove.
import { isAbsolute } from 'node:path';
import { isRunningAgentWorktree, runningAgentWorktrees } from './compose';
import { isLinkBranch, isMemberName } from './data/roadmap';
import { MAX_BATCH, parseLaunchOptions } from './launch';
import type { ItemStatus, RoadmapEdit, State, WebviewMessage, WorkItem } from './model';
import { isReleaseVersion } from './publish';
import { parseSettingEdit } from './settings';

// Claude Code session ids are UUIDs; anything else never reaches a shell command line.
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;

export const isSessionId = (id: string): boolean => SESSION_ID.test(id);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The message, if it is one the host understands; undefined otherwise. */
export function parseMessage(raw: unknown): WebviewMessage | undefined {
  if (!isObj(raw)) return undefined;
  switch (raw.type) {
    case 'ready':
    case 'refresh':
    case 'maximize':
    case 'cleanMerged':
    case 'openRoadmap':
    case 'openSettings':
    case 'caughtUp':
    case 'pullDefault':
      return { type: raw.type };
    case 'ship': {
      // What git accepts as a branch name and cannot be read as an option; the host also checks it is one it shows.
      const branch = field(raw.branch);
      return branch !== undefined && isLinkBranch(branch) ? { type: 'ship', branch } : undefined;
    }
    case 'release':
    case 'tag': {
      const version = field(raw.version);
      return version !== undefined && isReleaseVersion(version) ? { type: raw.type, version } : undefined;
    }
    case 'setSetting': {
      const edit = parseSettingEdit(raw.edit);
      return edit ? { type: 'setSetting', edit } : undefined;
    }
    case 'roadmap': {
      const edit = parseRoadmapEdit(raw.edit);
      return edit ? { type: 'roadmap', edit } : undefined;
    }
    case 'startClaude': {
      const ids = Array.isArray(raw.ids) ? raw.ids.map(field) : [];
      const options = parseLaunchOptions(raw.options);
      if (ids.length === 0 || ids.length > MAX_BATCH || !options) return undefined;
      if (!ids.every((id): id is string => id !== undefined)) return undefined;
      return { type: 'startClaude', ids: [...new Set(ids)], options };
    }
    case 'resumeSession':
    case 'focusSession':
    case 'openTranscript': {
      const sessionId = str(raw.sessionId);
      return sessionId ? { type: raw.type, sessionId } : undefined;
    }
    case 'openFolder': {
      const path = str(raw.path);
      return path ? { type: 'openFolder', path, newWindow: raw.newWindow === true } : undefined;
    }
    case 'openUrl': {
      const url = str(raw.url);
      return url ? { type: 'openUrl', url } : undefined;
    }
    case 'copy': {
      const text = str(raw.text);
      return text !== undefined ? { type: 'copy', text } : undefined;
    }
    default:
      return undefined;
  }
}

const MAX_FIELD = 1000;
const field = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= MAX_FIELD ? v : undefined);
const status = (v: unknown): ItemStatus | undefined => (v === 'todo' || v === 'doing' || v === 'done' ? v : undefined);

/** A roadmap edit with every field of the right kind; what the fields name is checked against the file itself. */
export function parseRoadmapEdit(raw: unknown): RoadmapEdit | undefined {
  if (!isObj(raw)) return undefined;
  const id = field(raw.id);
  const lane = field(raw.lane);
  const text = field(raw.text);
  switch (raw.op) {
    case 'create':
      return { op: 'create' };
    case 'add':
      return lane !== undefined && text !== undefined ? { op: 'add', lane, text } : undefined;
    case 'setText':
      return id !== undefined && text !== undefined ? { op: 'setText', id, text } : undefined;
    case 'setStatus': {
      const s = status(raw.status);
      return id !== undefined && s ? { op: 'setStatus', id, status: s } : undefined;
    }
    case 'move': {
      const s = status(raw.status);
      if (id === undefined || lane === undefined || !s) return undefined;
      const before = field(raw.before);
      return before === undefined ? { op: 'move', id, lane, status: s } : { op: 'move', id, lane, status: s, before };
    }
    case 'remove':
      return id !== undefined ? { op: 'remove', id } : undefined;
    case 'assign': {
      if (id === undefined) return undefined;
      if (raw.who === undefined) return { op: 'assign', id };
      return isMemberName(raw.who) ? { op: 'assign', id, who: raw.who } : undefined;
    }
    case 'setDuration': {
      if (id === undefined) return undefined;
      if (raw.duration === undefined) return { op: 'setDuration', id };
      const duration = field(raw.duration);
      return duration !== undefined ? { op: 'setDuration', id, duration } : undefined;
    }
    case 'addRelease': {
      const version = field(raw.version);
      if (version === undefined) return undefined;
      const title = field(raw.title);
      return title === undefined ? { op: 'addRelease', version } : { op: 'addRelease', version, title };
    }
    default:
      return undefined;
  }
}

/** Folders the webview may ask to open: worktrees, project roots and session working directories in the State.
 *  Absolute paths only: a relative one would resolve against the extension host's working directory. */
export function knownFolders(state: State): Set<string> {
  const out = new Set<string>();
  for (const item of state.work.items) if (item.worktreePath) out.add(item.worktreePath);
  if (state.work.repoRoot) out.add(state.work.repoRoot);
  for (const p of state.projects) out.add(p.key);
  for (const s of Object.values(state.sessions)) if (s.cwd) out.add(s.cwd);
  for (const f of out) if (!isAbsolute(f)) out.delete(f);
  return out;
}

/** Links the webview may ask to open: the ones the State shows (pull requests, their checks, CI runs, Needs you and
 *  Activity entries), and only https. */
export function knownUrls(state: State): Set<string> {
  const out = new Set<string>();
  for (const item of state.work.items) {
    if (item.pr?.url) out.add(item.pr.url);
    if (item.pr?.checks.url) out.add(item.pr.checks.url);
  }
  for (const r of state.work.ciRuns) out.add(r.url);
  for (const a of state.attention) if (a.url) out.add(a.url);
  for (const e of state.activity) if (e.url) out.add(e.url);
  for (const u of out) if (!isHttpsUrl(u)) out.delete(u);
  return out;
}

export function isHttpsUrl(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

/** What "Clean merged" may remove: merged branches other than the default, not checked out in an open VS Code
 *  folder (`openFolders`: this window's and other windows' that Cockpit knows of), with a clean worktree (or none),
 *  no live Claude or running subagent in it, and nothing the default branch lacks. A squash-merged branch is
 *  "merged" on the board (its PR merged), but its own commits are not in the default branch: git cannot verify it,
 *  so it is left to the person. */
export function cleanCandidates(state: State, openFolders: string[]): WorkItem[] {
  const sessions = Object.values(state.sessions);
  const liveCwds = sessions.filter((s) => s.live && s.cwd).map((s) => s.cwd);
  const running = runningAgentWorktrees(sessions);
  const inside = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`) || path.startsWith(`${dir}\\`);
  return state.work.items.filter(
    (i) =>
      i.group === 'merged' &&
      !i.isDefault &&
      !i.isCurrent &&
      i.dirtyCount === 0 &&
      i.ahead === 0 &&
      i.worktreePath !== state.work.repoRoot &&
      !isRunningAgentWorktree(i, running) &&
      // Git refuses such names anyway; this keeps a name from ever reading as an option on the command line.
      !i.branch.startsWith('-') &&
      !i.sessionIds.some((id) => state.sessions[id]?.live) &&
      !(i.worktreePath && liveCwds.some((cwd) => inside(cwd, i.worktreePath as string))) &&
      !(i.worktreePath && openFolders.some((f) => inside(f, i.worktreePath as string))),
  );
}

