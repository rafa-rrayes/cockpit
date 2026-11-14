// The three refreshable sources, as plain async functions with no `vscode` import: the store runs each on its own
// schedule, and scripts/dump-state.ts runs them once. Both then hand the results to compose().
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActivityEvent, ClaudeSession, Releases } from './model';
import type { GitResult, GithubResult } from './compose';
import { readClaude } from './data/claude';
import { projectRootOf, readGit, recentCommits } from './data/git';
import { type GithubRead, readGithub } from './data/github';
import { readReleases } from './data/releases';

const COMMIT_LIMIT = 30;

/** Where Claude Code keeps its files: CLAUDE_CONFIG_DIR when set (Claude Code honours it too), else ~/.claude. */
export const defaultClaudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

export function loadClaude(claudeDir: string, endedSessionDays: number, now: number): Promise<ClaudeSession[]> {
  return readClaude({ claudeDir, endedSessionDays, now, resolveProjectKey: projectRootOf });
}

export interface GitSnapshot {
  git: GitResult;
  commits: ActivityEvent[];
  releases: Releases;
}

/** Worktrees and branches, the default branch's recent commits, and releases (tags, ROADMAP.md, CHANGELOG.md):
 *  all local and cheap, so they refresh together. Outside git, releases still come from the folder's files. */
export async function loadGit(workspacePath: string, now: number): Promise<GitSnapshot> {
  const git = await readGit(workspacePath, now);
  // Files come from the worktree that is open (its CHANGELOG is the one being written); tags and counts from the
  // repository, which all its worktrees share.
  const [commits, releases] = await Promise.all([
    git.repoRoot ? recentCommits(git.repoRoot, COMMIT_LIMIT) : [],
    readReleases(git.toplevel ?? workspacePath, git.repoRoot ?? workspacePath),
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
