// The contract between the data layer (src/data/*, src/store.ts) and the UI (webview/).
// The extension host builds one State and posts the whole object to the webview on every change.
// Everything here is plain JSON (no Dates, no classes): times are epoch milliseconds.
// This file must not import `vscode` or node modules: both bundles compile it.

// ───────────────────────────── Claude sessions ─────────────────────────────

/** busy: working. waiting: blocked on the person (permission prompt, question). idle: live, nothing to do.
 *  ended: no live process. unknown: a live process whose status we could not read. */
export type SessionStatus = 'busy' | 'waiting' | 'idle' | 'ended' | 'unknown';

export interface Subagent {
  id: string; // "a3080e91bf6463e05"
  description: string;
  agentType: string; // "general-purpose", "Explore", ...
  model?: string;
  finished: boolean;
  /** The workflow run this agent belongs to, when it was spawned by one. */
  workflowRunId?: string;
  updatedAt?: number;
}

export type WorkflowStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface WorkflowPhase {
  title: string;
  detail?: string;
  /** done / current / pending when it can be derived from the run's progress; otherwise absent. */
  state?: 'done' | 'current' | 'pending';
}

export interface WorkflowRun {
  runId: string; // "wf_62124ac1-1cf"
  name?: string;
  summary?: string;
  status: WorkflowStatus;
  phases: WorkflowPhase[];
  agentCount?: number;
  startedAt?: number;
  durationMs?: number;
}

export interface ClaudeSession {
  sessionId: string;
  /** True when a process for it is alive right now. */
  live: boolean;
  pid?: number;
  status: SessionStatus;
  /** What a waiting session waits for, as Claude Code words it: "permission prompt", ... */
  waitingFor?: string;
  /** Best title: custom title, else AI title, else the session's name, else the first words of the last prompt. */
  title: string;
  /** The short name Claude Code gives a live session ("tanoar-53"). */
  name?: string;
  cwd: string;
  /** Key of the project this session belongs to: see Project.key. */
  projectKey: string;
  gitBranch?: string;
  lastPrompt?: string;
  /** Newest first, at most 5, each cut to about 300 characters. */
  recentPrompts: string[];
  startedAt?: number;
  /** Last activity: the live status file's updatedAt, else the transcript's modification time. */
  updatedAt?: number;
  claudeVersion?: string;
  transcriptPath?: string;
  /** Set by the store (not by the Claude adapter): the session runs in a terminal of this VS Code window,
   *  so "Focus terminal" works. */
  inVsCodeTerminal?: boolean;
  subagents: Subagent[];
  workflows: WorkflowRun[];
}

/** Sessions are grouped by project: the main checkout of the git repository the session's cwd is in
 *  (so a session inside a worktree belongs to the same project as one in the main checkout), or the cwd
 *  itself outside git. */
export interface Project {
  key: string; // absolute path of the project root
  name: string; // last path segment
  /** True for the project open in this VS Code window. */
  isWorkspace: boolean;
  sessionIds: string[]; // live first, then by updatedAt, newest first
}

// ───────────────────────────── Work: git and GitHub ─────────────────────────────

export type WorkGroup = 'active' | 'merged' | 'stale';

export interface CheckSummary {
  state: 'success' | 'failure' | 'pending' | 'none';
  url?: string;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  branch: string;
  isDraft: boolean;
  state: 'open' | 'merged' | 'closed';
  reviewDecision?: 'approved' | 'changes_requested' | 'review_required';
  checks: CheckSummary;
  updatedAt?: number;
}

/** One line of work: a branch, with its worktree if it has one. The default branch is included, first. */
export interface WorkItem {
  branch: string;
  isDefault: boolean;
  isCurrent: boolean; // checked out in the workspace folder
  /** active: has commits the default branch lacks, or uncommitted changes. merged: nothing the default
   *  branch lacks and clean. stale: unmerged, no commit for 14 days and no live session. */
  group: WorkGroup;
  worktreePath?: string;
  /** Uncommitted files in its worktree (0 when clean or when it has no worktree). */
  dirtyCount: number;
  ahead: number; // commits the default branch lacks
  behind: number; // commits of the default branch it lacks
  lastCommitAt?: number;
  lastCommitSubject?: string;
  /** Has a remote branch of the same name. */
  pushed: boolean;
  pr?: PullRequest;
  /** Sessions whose cwd is this worktree (or the main checkout while this branch is checked out there). */
  sessionIds: string[];
}

export interface CiRun {
  id: number;
  title: string;
  workflow: string;
  branch: string;
  status: 'success' | 'failure' | 'in_progress' | 'queued' | 'cancelled' | 'other';
  url: string;
  startedAt?: number;
  durationMs?: number;
}

export interface Work {
  /** False outside a git repository: the UI hides the section. */
  available: boolean;
  repoRoot?: string;
  defaultBranch?: string;
  /** "owner/name" when gh can see the repository; absent otherwise (no remote, gh missing or logged out). */
  github?: string;
  /** Why GitHub data is missing, in a few words, when it is. */
  githubNote?: string;
  items: WorkItem[];
  ciRuns: CiRun[]; // newest first, at most 10
}

// ───────────────────────────── Releases ─────────────────────────────

export interface ReleasePlan {
  version: string; // "1.2.0"
  title?: string; // "Comunidade"
  target?: string; // free text as written in ROADMAP.md: "week of 2026-11-16"
  status?: string; // free text: "planned", "in progress", "shipped"
  items: { text: string; done: boolean }[];
}

export interface ChangelogEntry {
  version: string; // "Unreleased" or "1.2.0"
  date?: string;
  lines: string[];
}

export interface Releases {
  /** False when the workspace has no version, tags, ROADMAP.md or CHANGELOG.md: the UI hides the section. */
  available: boolean;
  currentVersion?: string;
  /** Where currentVersion was read from, relative to the repo root: "app/app.json", "package.json". */
  versionSource?: string;
  latestTag?: string;
  latestTagAt?: number;
  commitsSinceTag?: number;
  roadmap: ReleasePlan[];
  /** Unreleased first, then newest versions, at most 5. */
  changelog: ChangelogEntry[];
}

// ───────────────────────────── Needs you, Activity ─────────────────────────────

export type AttentionKind = 'session_waiting' | 'ci_failed' | 'pr_changes_requested';

export interface Attention {
  kind: AttentionKind;
  title: string;
  detail?: string;
  sessionId?: string;
  url?: string;
  at?: number;
}

export type ActivityKind = 'commit' | 'session_started' | 'session_ended' | 'ci' | 'pr';

export interface ActivityEvent {
  kind: ActivityKind;
  at: number;
  title: string;
  detail?: string;
  sessionId?: string;
  url?: string;
  branch?: string;
}

// ───────────────────────────── State ─────────────────────────────

export interface State {
  generatedAt: number;
  workspace?: { name: string; path: string };
  attention: Attention[];
  /** Keyed by sessionId. */
  sessions: Record<string, ClaudeSession>;
  /** The workspace's project first, then projects with live sessions, then the rest by latest activity. */
  projects: Project[];
  work: Work;
  releases: Releases;
  /** Newest first, at most 60. */
  activity: ActivityEvent[];
}

export const emptyState = (): State => ({
  generatedAt: Date.now(),
  attention: [],
  sessions: {},
  projects: [],
  work: { available: false, items: [], ciRuns: [] },
  releases: { available: false, roadmap: [], changelog: [] },
  activity: [],
});

// ───────────────────────────── Messages ─────────────────────────────

/** Extension host → webview. */
export type HostMessage = { type: 'state'; state: State };

/** Webview → extension host. Every action is explicit: the UI never changes anything on its own. */
export type WebviewMessage =
  | { type: 'ready' } // the webview loaded: send State
  | { type: 'refresh' }
  | { type: 'resumeSession'; sessionId: string } // new terminal: claude --resume <id> in the session's cwd
  | { type: 'focusSession'; sessionId: string } // show the VS Code terminal running it, when there is one
  | { type: 'openTranscript'; sessionId: string }
  | { type: 'openFolder'; path: string; newWindow: boolean }
  | { type: 'openUrl'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'cleanMerged' }; // the host lists what it would delete and asks before deleting anything
