// The checks behind actions.ts, kept free of `vscode` so they are unit-tested: what the webview may ask for,
// and what "Clean merged" may remove.
import { isAbsolute } from 'node:path';
import { isRunningAgentWorktree, runningAgentWorktrees } from './compose';
import type { State, WebviewMessage, WorkItem } from './model';

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
    case 'cleanMerged':
      return { type: raw.type };
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

