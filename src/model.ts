// The contract between the data layer (src/data/*, src/store.ts) and the UI (webview/).
// The extension host builds one State and posts the whole object to the webview on every change.
// Everything here is plain JSON (no Dates, no classes): times are epoch milliseconds.
// This file must not import `vscode` or node modules: both bundles compile it.
import { type SettingEdit, defaultSettings } from './settings';

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
  /** The session's last answer: the text of its newest assistant message, cut to about 20,000 characters. Only for
   *  sessions of the workspace's project (compose drops the others, to keep the State small). */
  report?: string;
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

/** One job of a CI run, as GitHub lists it on the run page. */
export interface CiJob {
  name: string;
  status: 'success' | 'failure' | 'in_progress' | 'queued' | 'cancelled' | 'skipped' | 'other';
  url?: string;
  startedAt?: number;
  durationMs?: number;
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
  /** Only for runs that are queued or in progress: what the run page lists. */
  jobs?: CiJob[];
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

export type ItemStatus = 'todo' | 'doing' | 'done';

/** One card of the roadmap board: a list item of ROADMAP.md. */
export interface RoadmapItem {
  /** "<line>:<hash of the line>": where the item was when the file was read. An edit names its item by id, and
   *  is refused when the file no longer has that line. */
  id: string;
  text: string;
  status: ItemStatus; // "- [ ]" todo, "- [~]" doing, "- [x]" done
  /** The branch working on the card: Start Claude records it in ROADMAP.md as "<!-- cockpit:<branch> -->" at the
   *  end of the card's line, and it is dropped when the branch's pull request merges. */
  branch?: string;
}

/** One lane of the board: a planned release, or the backlog (work not yet in a release). */
export interface ReleasePlan {
  /** "1.2.0"; for the backlog, its heading as written ("Backlog"). Names the lane in edits. */
  version: string;
  backlog?: boolean;
  title?: string; // "Comunidade"
  target?: string; // free text as written in ROADMAP.md: "week of 2026-11-16"
  status?: string; // free text: "planned", "in progress", "shipped"
  items: RoadmapItem[];
}

/** What the board can change in ROADMAP.md. `lane` is a ReleasePlan.version; "Backlog" is created when missing. */
export type RoadmapEdit =
  | { op: 'create' } // write a starter ROADMAP.md when there is none
  | { op: 'add'; lane: string; text: string }
  | { op: 'setText'; id: string; text: string }
  | { op: 'setStatus'; id: string; status: ItemStatus } // in place
  | { op: 'move'; id: string; lane: string; status: ItemStatus; before?: string } // before: an item id of that lane; absent: the lane's end
  | { op: 'remove'; id: string }
  | { op: 'addRelease'; version: string; title?: string };

/** Claude Code's model aliases (`claude --model <alias>`): each names the latest model of its family. */
export type ClaudeModel = 'fable' | 'opus' | 'sonnet' | 'haiku';
/** `claude --effort <level>`: how much the model thinks. */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** How the board starts a Claude on roadmap cards. */
export interface LaunchOptions {
  /** Absent: Claude Code's own default model. */
  model?: ClaudeModel;
  effort: Effort;
  /** 0: the Claude works alone. */
  subagents: number;
  /** The model every subagent runs on, whatever the Claude asks for. Absent: Claude Code decides. */
  subagentModel?: ClaudeModel;
  /** `claude --worktree`: a new git worktree and branch for the session. */
  worktree: boolean;
  /** Move the cards that are still planned to "In progress" once the Claude starts. */
  markDoing: boolean;
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
  /** Where ROADMAP.md is, or would be created: set whenever a folder is open. */
  roadmapPath?: string;
  roadmapExists?: boolean;
  /** Lanes in file order. */
  roadmap: ReleasePlan[];
  /** Unreleased first, then newest versions, at most 5. */
  changelog: ChangelogEntry[];
}

// ───────────────────────────── Needs you, Activity ─────────────────────────────

/** session_uncommitted: a Claude stopped (idle or ended) and left uncommitted changes in its worktree. */
export type AttentionKind = 'session_waiting' | 'session_uncommitted' | 'ci_failed' | 'pr_changes_requested';

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

// ───────────────────────────── Catch up ─────────────────────────────

/** What a pull request looked like when the person last caught up: merged, closed, or the state of its checks. */
export type PrMark = 'merged' | 'closed' | CheckSummary['state'];

/** The last time the person caught up (opened Catch up and closed it), and the pull requests as they were then:
 *  Catch up shows what changed after it. Kept per workspace by the host. */
export interface CatchUpMark {
  at: number;
  /** By pull request number. */
  prs: Record<string, PrMark>;
}

// ───────────────────────────── Settings ─────────────────────────────

export type SectionId = 'needs' | 'claudes' | 'roadmap' | 'work' | 'releases' | 'activity';

/** Cockpit's VS Code settings (cockpit.*), checked: see src/settings.ts. */
export interface Settings {
  openOnStartup: boolean;
  /** Claudes shows every project's sessions; off, only the workspace project's. */
  showAllProjects: boolean;
  endedSessionDays: number;
  githubPollSeconds: number;
  /** Sections the page leaves out. */
  hiddenSections: SectionId[];
  /** What the roadmap's launcher opens with. */
  launch: LaunchOptions;
  /** The general steps of the prompt a Claude started from the board gets. Empty: the standard ones. */
  promptSteps: string[];
  /** Files Release bumps the version in besides the root package.json, relative to the repository root. */
  releaseVersionFiles: string[];
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
  settings: Settings;
  /** Absent until the person first caught up in this workspace. */
  caughtUp?: CatchUpMark;
}

export const emptyState = (): State => ({
  generatedAt: Date.now(),
  attention: [],
  sessions: {},
  projects: [],
  work: { available: false, items: [], ciRuns: [] },
  releases: { available: false, roadmap: [], changelog: [] },
  activity: [],
  settings: defaultSettings,
});

// ───────────────────────────── Messages ─────────────────────────────

/** Extension host → webview. */
export type HostMessage = { type: 'state'; state: State };

/** Webview → extension host. Every action is explicit: the UI never changes anything on its own. */
export type WebviewMessage =
  | { type: 'ready' } // the webview loaded: send State
  | { type: 'refresh' }
  | { type: 'toggleMaximize' } // Zen mode on or off; the Cockpit tab is the active editor when its button is clicked
  | { type: 'resumeSession'; sessionId: string } // new terminal: claude --resume <id> in the session's cwd
  | { type: 'focusSession'; sessionId: string } // show the VS Code terminal running it, when there is one
  | { type: 'openTranscript'; sessionId: string }
  | { type: 'openFolder'; path: string; newWindow: boolean }
  | { type: 'openUrl'; url: string }
  | { type: 'copy'; text: string }
  | { type: 'cleanMerged' } // the host lists what it would delete and asks before deleting anything
  | { type: 'roadmap'; edit: RoadmapEdit } // edits ROADMAP.md; removing an item asks first
  | { type: 'startClaude'; ids: string[]; options: LaunchOptions } // a new terminal running claude on these cards
  | { type: 'openRoadmap' } // ROADMAP.md in the editor
  | { type: 'setSetting'; edit: SettingEdit } // writes one cockpit.* setting to the user's or the workspace's settings
  | { type: 'openSettings' } // VS Code's Settings, filtered to Cockpit
  | { type: 'caughtUp' } // Catch up was closed: what it showed is seen
  | { type: 'ship'; branch: string } // push the branch and open its PR, after a confirmation that shows both
  | { type: 'release'; version: string } // the release PR of a lane whose cards are done, after a confirmation
  | { type: 'tag'; version: string } // tag the merged release and push the tag, after a confirmation
  | { type: 'pullDefault' }; // git pull --ff-only --autostash in the main checkout
