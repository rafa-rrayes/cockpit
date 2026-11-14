// The three refreshable sources, as plain async functions with no `vscode` import: the store runs each on its own
// schedule, and scripts/dump-state.ts runs them once. Both then hand the results to compose().
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ActivityEvent, ClaudeSession, Releases } from './model';
import type { GitResult, GithubResult } from './compose';
import { readClaude } from './data/claude';
import { projectRootOf, readGit, recentCommits } from './data/git';
import { readGithub } from './data/github';
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
  const root = git.repoRoot ?? workspacePath;
  const [commits, releases] = await Promise.all([git.repoRoot ? recentCommits(git.repoRoot, COMMIT_LIMIT) : [], readReleases(root)]);
  return { git, commits, releases };
}

export function loadGithub(repoRoot: string): Promise<GithubResult> {
  return readGithub(repoRoot);
}
