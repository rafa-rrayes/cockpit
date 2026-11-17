// The three refreshable sources, as plain async functions with no `vscode` import: the store runs each on its own
// schedule, and scripts/dump-state.ts runs them once. Both then hand the results to compose().
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActivityEvent, ClaudeSession, Releases } from './model';
import type { GitResult, GithubResult } from './compose';
import { readClaude } from './data/claude';
import { readCodex } from './data/codex';
import { readManaged } from './data/managed';
import { readOtherAgents } from './data/otherAgents';
import { readConfig, resolveDelivery } from './data/cockpitDir';
import { hasOrigin, projectRootOf, readGit, recentCommits } from './data/git';
import { type GithubRead, readGithub } from './data/github';
import { readReleases } from './data/releases';

const COMMIT_LIMIT = 30;

/** Where Claude Code keeps its files: CLAUDE_CONFIG_DIR when set (Claude Code honours it too), else ~/.claude. */
export const defaultClaudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

export function loadClaude(claudeDir: string, endedSessionDays: number, now: number): Promise<ClaudeSession[]> {
  return readClaude({ claudeDir, endedSessionDays, now, resolveProjectKey: projectRootOf });
}

export const defaultCodexDir = (): string => process.env.CODEX_HOME || join(homedir(), '.codex');

/** Merge the native adapters and the portable process bridge. A failed provider never hides another one's sessions. */
export async function loadAgents(claudeDir: string, endedSessionDays: number, now: number, log: (line: string) => void = () => {}): Promise<ClaudeSession[]> {
  const opts = { endedSessionDays, now, resolveProjectKey: projectRootOf };
  const results = await Promise.allSettled([
    loadClaude(claudeDir, endedSessionDays, now).then((ss) => ss.map((s) => ({ ...s, provider: 'claude', nativeSessionId: s.sessionId, agentVersion: s.claudeVersion, canResume: true }))),
    readCodex({ ...opts, codexDir: defaultCodexDir() }),
    readOtherAgents({ ...opts, geminiDir: process.env.COCKPIT_GEMINI_DIR, opencodeCommand: process.env.COCKPIT_OPENCODE_COMMAND }),
    readManaged(opts),
  ]);
  const sessions: ClaudeSession[] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sessions.push(...r.value);
    else log(`${['Claude Code', 'Codex', 'Other agents', 'Managed agents'][i]} discovery failed: ${String(r.reason)}`);
  });
  return mergeAgentSessions(sessions);
}

/** A resumed native session also has a process wrapper: keep the rich native transcript and the observed lifetime. */
export function mergeAgentSessions(sessions: ClaudeSession[]): ClaudeSession[] {
  const native = new Map<string, ClaudeSession>();
  const result: ClaudeSession[] = [];
  for (const s of sessions) {
    if (s.sessionId.startsWith('managed:')) continue;
    const copy = { ...s };
    native.set(`${s.provider ?? 'claude'}:${s.nativeSessionId ?? s.sessionId}`, copy);
    result.push(copy);
  }
  const managedGroups = new Map<string, ClaudeSession[]>();
  for (const s of sessions.filter((s) => s.sessionId.startsWith('managed:'))) {
    const key = s.nativeSessionId ? `${s.provider}:${s.nativeSessionId}` : s.sessionId;
    const group = managedGroups.get(key) ?? [];
    group.push(s); managedGroups.set(key, group);
  }
  const newest = (a: ClaudeSession, b: ClaudeSession) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || b.sessionId.localeCompare(a.sessionId);
  for (const [key, group] of managedGroups) {
    group.sort(newest);
    const latest = group[0]!;
    let s = native.get(key);
    if (!s) {
      // Keep one stable identity across custom-provider resumes, with the newest data and any observed live process.
      const first = [...group].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.sessionId.localeCompare(b.sessionId))[0]!;
      s = { ...latest, sessionId: first.sessionId };
      result.push(s);
    }
    const managed = group.find((m) => m.live);
    if (managed) {
      const nativeLive = s.live;
      s.live = true;
      s.pid = managed.pid;
      // A native live status is more informative than an unknown wrapper status; hook reports are explicit.
      if (managed.status !== 'unknown' || s.status === 'ended' || !nativeLive) {
        s.status = managed.status;
        s.statusNote = managed.statusNote;
        s.waitingFor = managed.waitingFor;
      }
    }
    const report = group.find((m) => m.report !== undefined);
    if (report && (!s.report || (report.updatedAt ?? 0) >= (s.updatedAt ?? 0))) s.report = report.report;
  }
  return result;
}

export interface GitSnapshot {
  git: GitResult;
  commits: ActivityEvent[];
  releases: Releases;
}

/** Worktrees and branches, the default branch's recent commits, releases (tags, the board, CHANGELOG.md), whether
 *  there is an origin and how work is delivered (.cockpit/config.json): all local and cheap, so they refresh
 *  together. Outside git, releases still come from the folder's files. */
export async function loadGit(workspacePath: string, now: number): Promise<GitSnapshot> {
  const read = await readGit(workspacePath, now);
  const root = read.repoRoot ?? workspacePath;
  const [config, origin] = await Promise.all([readConfig(root), read.repoRoot ? hasOrigin(read.repoRoot) : false]);
  const git: GitResult = { ...read, hasOrigin: origin, delivery: resolveDelivery(config.delivery, origin) };
  // Files come from the worktree that is open (its CHANGELOG is the one being written); the board, tags and counts
  // from the repository, which all its worktrees share.
  const [commits, releases] = await Promise.all([
    read.repoRoot ? recentCommits(read.repoRoot, COMMIT_LIMIT) : [],
    readReleases(read.toplevel ?? workspacePath, root, config),
  ]);
  return { git, commits, releases };
}

/** The new answer, with the last good lists kept where gh could not read them this time (offline, a timeout):
 *  a network blip must not empty the board or Needs you. The note then says the lists are not fresh. */
export function keepLastGood(prev: GithubResult | undefined, next: GithubRead): GithubResult {
  const prs = next.prs ?? prev?.prs;
  const ciRuns = next.ciRuns ?? prev?.ciRuns;
  // Carrying an empty list over is the same as having none, and must not claim there is an earlier answer.
  const kept = (next.prs === undefined && (prs?.length ?? 0) > 0) || (next.ciRuns === undefined && (ciRuns?.length ?? 0) > 0);
  const out: GithubResult = { prs: prs ?? [], ciRuns: ciRuns ?? [] };
  const github = next.github ?? (kept ? prev?.github : undefined);
  if (github) out.github = github;
  if (next.githubNote) out.githubNote = kept ? `${next.githubNote}; showing the last answer` : next.githubNote;
  return out;
}

/** One read of GitHub; `prev` is the last result for the same repository, if any. */
export async function loadGithub(repoRoot: string, prev?: GithubResult): Promise<GithubResult> {
  return keepLastGood(prev, await readGithub(repoRoot));
}
