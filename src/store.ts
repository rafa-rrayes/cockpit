// Owns the refresh loop. Three sources refresh on their own triggers and never block each other:
//   claude: fs.watch on <claudeDir>/sessions (debounced), terminal changes, and a slow safety timer;
//   git (worktrees, branches, commits, releases): fs.watch on the git dir, file saves, and a timer, while visible;
//   github: a timer (cockpit.githubPollSeconds), only while the panel is visible.
// A source that fails keeps its last good result, so one failure never blanks the others, and a source never
// runs twice at once: a trigger during a run asks for one more run after it.
import { type FSWatcher, watch } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { compose, type GithubResult } from './compose';
import { runGit, projectRootOf } from './data/git';
import type { ClaudeSession, State } from './model';
import { ancestorsOf, readProcessTable } from './procs';
import { type GitSnapshot, loadClaude, loadGit, loadGithub } from './sources';

const CLAUDE_DEBOUNCE_MS = 300;
const GIT_DEBOUNCE_MS = 1000;
const CLAUDE_TIMER_VISIBLE_MS = 15_000;
const CLAUDE_TIMER_HIDDEN_MS = 60_000;
const GIT_TIMER_MS = 15_000;
const MIN_GITHUB_SECONDS = 15;

/** Runs `load` with no overlap: a request while it runs schedules exactly one more run after it. */
class Source<T> {
  value: T | undefined;
  lastRunAt = 0;
  private running: Promise<void> | undefined;
  private again = false;
  private disposed = false;

  constructor(
    readonly name: string,
    private readonly load: () => Promise<T>,
    private readonly done: () => void,
    private readonly log: (line: string) => void,
  ) {}

  run(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      do {
        this.again = false;
        this.lastRunAt = Date.now();
        try {
          this.value = await this.load();
        } catch (e) {
          this.log(`${this.name} failed, keeping its last result: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        }
        if (!this.disposed) this.done();
      } while (this.again && !this.disposed);
      this.running = undefined;
    })();
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Calls `fn` once, `ms` after the last of a burst of calls. */
function debounce(fn: () => void, ms: number): { (): void; cancel(): void } {
  let timer: NodeJS.Timeout | undefined;
  const call = () => {
    clearTimeout(timer);
    timer = setTimeout(fn, ms);
  };
  call.cancel = () => clearTimeout(timer);
  return call;
}

export interface StoreOptions {
  workspace?: { name: string; path: string };
  claudeDir: string;
  log: (line: string) => void;
}

export class Store implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<State>();
  /** A new State after every refresh of any source. */
  readonly onDidChange = this.emitter.event;
  private current: State | undefined;
  private visible = false;
  private gitDirty = false;
  private workspaceProjectKey: string | undefined;
  /** sessionId → the terminal it runs in, from the last claude refresh. */
  private terminalOf = new Map<string, vscode.Terminal>();

  private readonly claude: Source<ClaudeSession[]>;
  private readonly git: Source<GitSnapshot>;
  private readonly github: Source<GithubResult>;

  private claudeWatcher: FSWatcher | undefined;
  private gitWatchers: FSWatcher[] = [];
  private watchedGitDir: string | undefined;
  /** The first git run: GitHub waits for it, because it needs the repository root. */
  private readonly firstGit: Promise<void>;
  private claudeTimer: NodeJS.Timeout | undefined;
  private gitTimer: NodeJS.Timeout | undefined;
  private githubTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly claudeSoon = debounce(() => void this.claude.run(), CLAUDE_DEBOUNCE_MS);
  private readonly gitSoon = debounce(() => this.gitChanged(), GIT_DEBOUNCE_MS);

  constructor(private readonly opts: StoreOptions) {
    const changed = () => this.emit();
    this.claude = new Source('Claude sessions', () => this.loadClaude(), changed, opts.log);
    this.git = new Source(
      'git',
      async () => {
        const ws = this.opts.workspace;
        if (!ws) return { git: { available: false, items: [] }, commits: [], releases: { available: false, roadmap: [], changelog: [] } };
        return loadGit(ws.path, Date.now());
      },
      () => {
        this.watchGitDir();
        changed();
      },
      opts.log,
    );
    this.github = new Source(
      'GitHub',
      async () => {
        await this.firstGit;
        const root = this.git.value?.git.repoRoot;
        return root ? loadGithub(root) : { prs: [], ciRuns: [] };
      },
      changed,
      opts.log,
    );

    this.watchClaudeSessions();
    this.disposables.push(
      vscode.window.onDidOpenTerminal(() => this.claudeSoon()),
      vscode.window.onDidCloseTerminal(() => this.claudeSoon()),
      vscode.workspace.onDidSaveTextDocument(() => this.gitSoon()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cockpit.endedSessionDays')) void this.claude.run();
        if (e.affectsConfiguration('cockpit.githubPollSeconds')) this.scheduleGithub();
      }),
    );
    this.scheduleClaude();
    void this.claude.run();
    // GitHub starts when the panel becomes visible (setVisible).
    this.firstGit = this.git.run();
  }

  get state(): State | undefined {
    return this.current;
  }

  terminalFor(sessionId: string): vscode.Terminal | undefined {
    return this.terminalOf.get(sessionId);
  }

  /** Every source once, now; resolves when all have finished. */
  async refresh(): Promise<void> {
    await Promise.all([this.claude.run(), this.git.run().then(() => this.github.run())]);
  }

  /** Git only (after a change made from Cockpit, such as removing worktrees). */
  refreshGit(): Promise<void> {
    return this.git.run();
  }

  /** The panel's visibility: git polling and GitHub run only while it is visible. */
  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.scheduleClaude();
    this.scheduleGit();
    this.scheduleGithub();
    if (!visible) return;
    if (this.gitDirty || Date.now() - this.git.lastRunAt > GIT_TIMER_MS) {
      this.gitDirty = false;
      void this.git.run();
    }
    // GitHub waits for the git run it needs; skip it when the last answer is recent.
    if (Date.now() - this.github.lastRunAt > this.githubPollMs() / 2) void this.github.run();
  }

  private async loadClaude(): Promise<ClaudeSession[]> {
    const days = vscode.workspace.getConfiguration('cockpit').get<number>('endedSessionDays', 7);
    const now = Date.now();
    const [sessions] = await Promise.all([
      loadClaude(this.opts.claudeDir, Math.max(0, days), now),
      this.opts.workspace && !this.workspaceProjectKey
        ? projectRootOf(this.opts.workspace.path).then((k) => (this.workspaceProjectKey = k))
        : undefined,
    ]);
    await this.markTerminals(sessions);
    return sessions;
  }

  /** Sets inVsCodeTerminal on live sessions whose process descends from a terminal of this window. */
  private async markTerminals(sessions: ClaudeSession[]): Promise<void> {
    const next = new Map<string, vscode.Terminal>();
    const live = sessions.filter((s) => s.live && s.pid !== undefined);
    const terminals = vscode.window.terminals;
    if (live.length > 0 && terminals.length > 0) {
      const [parents, pids] = await Promise.all([
        readProcessTable(),
        Promise.all(terminals.map((t) => Promise.resolve(t.processId).catch(() => undefined))),
      ]);
      const byPid = new Map<number, vscode.Terminal>();
      terminals.forEach((t, i) => {
        const pid = pids[i];
        if (pid !== undefined) byPid.set(pid, t);
      });
      for (const s of live) {
        const pid = s.pid as number;
        // The claude process itself can be the terminal's process (a terminal started with claude as its shell).
        const terminal = [pid, ...ancestorsOf(pid, parents)].map((p) => byPid.get(p)).find((t) => t !== undefined);
        if (!terminal) continue;
        s.inVsCodeTerminal = true;
        next.set(s.sessionId, terminal);
      }
    }
    this.terminalOf = next;
  }

  private emit(): void {
    const git = this.git.value;
    this.current = compose({
      now: Date.now(),
      workspace: this.opts.workspace,
      workspaceProjectKey: this.workspaceProjectKey ?? this.opts.workspace?.path,
      sessions: this.claude.value ?? [],
      git: git?.git,
      github: this.github.value,
      releases: git?.releases,
      commits: git?.commits,
    });
    this.emitter.fire(this.current);
  }

  // ───────────────────────────── Triggers ─────────────────────────────

  private watchClaudeSessions(): void {
    const dir = join(this.opts.claudeDir, 'sessions');
    try {
      const w = watch(dir, () => this.claudeSoon());
      w.on('error', (e) => {
        // The directory was removed: the safety timer watches again once it is back.
        this.opts.log(`watching ${dir} stopped: ${e.message}`);
        w.close();
        if (this.claudeWatcher === w) this.claudeWatcher = undefined;
      });
      this.claudeWatcher = w;
    } catch (e) {
      // No sessions directory yet (Claude Code never ran): the safety timer still notices when it appears.
      this.opts.log(`not watching ${dir}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Watches the repository's git dir once its location is known: HEAD and packed-refs (top level), branch refs,
   *  and each worktree's HEAD and index. The workspace's dirty files are caught by saves and the timer. */
  private watchGitDir(): void {
    const root = this.git.value?.git.repoRoot;
    if (!root) return;
    void runGit(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], 5000).then((r) => {
      const dir = r.ok ? r.stdout.trim() : undefined;
      if (!dir || dir === this.watchedGitDir) return;
      for (const w of this.gitWatchers) w.close();
      this.gitWatchers = [];
      this.watchedGitDir = dir;
      const onChange = (_event: string, file: string | Buffer | null) => {
        // Lock files come and go around every write; the write itself also fires.
        if (typeof file === 'string' && file.endsWith('.lock')) return;
        this.gitSoon();
      };
      for (const [path, recursive] of [
        [dir, false],
        [join(dir, 'refs'), true],
        [join(dir, 'worktrees'), true],
      ] as const) {
        try {
          const w = watch(path, { recursive }, onChange);
          w.on('error', () => w.close());
          this.gitWatchers.push(w);
        } catch {
          // worktrees/ only exists once a worktree was added; the timer covers it until then.
        }
      }
      this.opts.log(`watching ${basename(dir)} in ${root}`);
    });
  }

  private gitChanged(): void {
    if (this.visible) void this.git.run();
    else this.gitDirty = true;
  }

  private githubPollMs(): number {
    const s = vscode.workspace.getConfiguration('cockpit').get<number>('githubPollSeconds', 60);
    return Math.max(MIN_GITHUB_SECONDS, Number.isFinite(s) ? s : 60) * 1000;
  }

  private scheduleClaude(): void {
    clearInterval(this.claudeTimer);
    this.claudeTimer = setInterval(() => {
      if (!this.claudeWatcher) this.watchClaudeSessions();
      void this.claude.run();
    }, this.visible ? CLAUDE_TIMER_VISIBLE_MS : CLAUDE_TIMER_HIDDEN_MS);
  }

  private scheduleGit(): void {
    clearInterval(this.gitTimer);
    this.gitTimer = this.visible ? setInterval(() => void this.git.run(), GIT_TIMER_MS) : undefined;
  }

  private scheduleGithub(): void {
    clearInterval(this.githubTimer);
    this.githubTimer = this.visible ? setInterval(() => void this.github.run(), this.githubPollMs()) : undefined;
  }

  dispose(): void {
    this.claudeSoon.cancel();
    this.gitSoon.cancel();
    for (const t of [this.claudeTimer, this.gitTimer, this.githubTimer]) clearInterval(t);
    this.claudeWatcher?.close();
    for (const w of this.gitWatchers) w.close();
    for (const s of [this.claude, this.git, this.github]) s.dispose();
    for (const d of this.disposables) d.dispose();
    this.emitter.dispose();
  }
}
