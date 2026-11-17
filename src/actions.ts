// Every message the webview can post, handled here. The webview is treated as untrusted input: each message is
// checked against the current State (known session ids, known paths, links it shows) before anything happens, and
// nothing changes on disk except through cleanMerged, which lists what it would do and asks first, and through the
// roadmap board, which edits the board's file (and makes .cockpit/ for it) and nothing else, and through the settings
// popover, which writes cockpit.* settings only, each value checked against what its setting takes. Starting a Claude
// on cards opens a terminal; the Claude it runs is then the one that changes things, in the terminal, under its own
// permission prompts. Ship, Release and Tag show what they will do and do nothing until the person confirms; asked
// through the `cockpit` command (runAgentAction), only what leaves the machine asks, and the rest runs at once.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import * as vscode from 'vscode';
import { type AgentAction, type AgentResult, statusLines } from './agent';
import { markOf, shipProblem } from './catchup';
import { removeMerged } from './clean';
import { ensureCockpitDir } from './data/cockpitDir';
import { runGit } from './data/git';
import { managedTerminal } from './managedLaunch';
import { isNativeSessionId, providerArgs, providerFor } from './providers';
import { runGh } from './data/github';
import { type EditResult, applyRoadmapEdit, finishBranch, finishMerged, linkCard, parseRoadmap, setLaneStatus, starterRoadmap } from './data/roadmap';
import { cleanCandidates, isHttpsUrl, isSessionId, knownFolders, knownUrls, parseMessage } from './guards';
import { type LaunchCard, agentLaunchArgs, launchArgs, launchEnv, launchPrompt, sessionName, worktreeName } from './launch';
import type { CatchUpMark, ClaudeSession, LaunchOptions, RoadmapEdit, State, WorkItem } from './model';
import { type ShippedCard, mergedWork, prBody, prTitle, releaseBody, releaseBranch, releaseStep, releaseTitle, tagName } from './publish';
import { isProjectSetting, storedValue } from './settings';
import {
  type Outcome,
  REMOTE,
  commitRelease,
  draftDirect,
  draftRelease,
  findDirectTag,
  findRelease,
  isTracked,
  mergeBranch,
  openRelease,
  prsFrom,
  pullDefault,
  pushTag,
  remoteProblem,
  shipBranch,
} from './ship';

export interface ActionHost {
  state(): State | undefined;
  refresh(): Promise<void>;
  /** Claude sessions and git, not GitHub: what "Clean merged" decides on. */
  refreshLocal(): Promise<void>;
  refreshGit(): Promise<void>;
  /** Folders open in other VS Code windows. */
  otherWindowFolders(): string[];
  terminalFor(sessionId: string): vscode.Terminal | undefined;
  /** Sends the current State to the webview again. */
  resend(): void;
  /** ROADMAP.md now reads `text`: show it at once, without waiting for the next git refresh. */
  roadmapChanged(text: string): void;
  /** The person closed Catch up: remember what it showed. */
  caughtUp(mark: CatchUpMark): Promise<void>;
}

/** Bigger transcripts are revealed in the OS file manager instead: the editor struggles with hundreds of MB. */
const MAX_TRANSCRIPT_EDITOR_BYTES = 20 * 1024 * 1024;
const MAX_COPY_CHARS = 10_000;

export async function handleMessage(raw: unknown, host: ActionHost): Promise<void> {
  const msg = parseMessage(raw);
  if (!msg) return;
  const state = host.state();
  switch (msg.type) {
    case 'ready':
      host.resend();
      return;
    case 'refresh':
      await host.refresh();
      return;
    case 'maximize':
      await vscode.commands.executeCommand('cockpit.maximize');
      return;
    case 'copy':
      await vscode.env.clipboard.writeText(msg.text.slice(0, MAX_COPY_CHARS));
      vscode.window.setStatusBarMessage('Cockpit: copied', 2000);
      return;
    case 'openUrl':
      if (!state || !knownUrls(state).has(msg.url)) return refuse('Cockpit only opens the links it shows.');
      await vscode.env.openExternal(vscode.Uri.parse(msg.url, true));
      return;
    case 'openFolder':
      if (!state || !knownFolders(state).has(msg.path)) return refuse('Cockpit only opens folders it shows.');
      if (!existsSync(msg.path)) return refuse(`${msg.path} no longer exists.`);
      // Always a new window, whatever the message says: replacing this window's folder is never what a button means.
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.path), { forceNewWindow: true });
      return;
    case 'resumeSession':
    case 'focusSession':
    case 'openTranscript': {
      const session = state?.sessions[msg.sessionId];
      if (!session) return refuse('That session is no longer in the list.');
      if (msg.type === 'resumeSession') return resume(session, host);
      if (msg.type === 'focusSession') return focus(session, host);
      return openTranscript(session);
    }
    case 'cleanMerged':
      return cleanMerged(host);
    case 'roadmap':
      // One edit at a time: each reads the file the one before it wrote.
      return inRoadmapQueue(() => editRoadmap(msg.edit, host));
    case 'startAgent':
    case 'startClaude':
      // In the roadmap queue: the cards are read as the edits before left the file, and marking them follows.
      return inRoadmapQueue(() => startAgent(msg.ids, msg.options, host));
    case 'caughtUp':
      if (state) await host.caughtUp(markOf(state, Date.now()));
      return;
    case 'ship':
      return ship(msg.branch, host);
    case 'release':
      return release(msg.version, host);
    case 'tag':
      return tag(msg.version, host);
    case 'pullDefault':
      return pull(host);
    case 'setSetting': {
      // A project setting goes to the workspace's settings (.vscode/settings.json), the others to the user's, where
      // VS Code's Settings shows them; a workspace value set there for one of those still wins.
      const project = isProjectSetting(msg.edit.key);
      if (project && !vscode.workspace.workspaceFolders?.length) return;
      const target = project ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
      await vscode.workspace.getConfiguration('cockpit').update(msg.edit.key, storedValue(msg.edit), target);
      return;
    }
    case 'openSettings':
      await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:rrayes.cockpit');
      return;
    case 'openRoadmap': {
      const path = state?.releases.roadmapPath;
      if (!path || !existsSync(path)) return refuse('There is no roadmap yet.');
      await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false, viewColumn: vscode.ViewColumn.Beside });
      return;
    }
  }
}

/** What the `cockpit` command asked for (src/cli.ts, through the inbox): the same actions as the board's buttons,
 *  answered in lines to print. Only what leaves the machine asks in a VS Code dialog first. */
export async function runAgentAction(action: AgentAction, host: ActionHost): Promise<AgentResult> {
  if (action.verb === 'status') {
    await host.refreshLocal();
    const state = host.state();
    return state ? { ok: true, lines: statusLines(state, action.branch) } : { ok: false, lines: ['Cockpit has not read this repository yet. Try again in a moment.'] };
  }
  const ch = cliChannel();
  switch (action.verb) {
    case 'ship':
      // The Claude that runs `cockpit ship` is the one working on the branch: it does not count as busy.
      await ship(action.branch, host, ch, { self: true });
      break;
    case 'release':
      await release(action.version, host, ch);
      break;
    case 'tag':
      await tag(action.version, host, ch);
      break;
    case 'pull':
      await pull(host, ch);
      break;
    case 'add':
      await inRoadmapQueue(() => agentEdit({ op: 'add', lane: action.lane, text: action.text }, host, ch));
      break;
    case 'lane':
      await inRoadmapQueue(() => agentEdit({ op: 'addRelease', version: action.version, ...(action.title ? { title: action.title } : {}) }, host, ch));
      break;
  }
  return ch.result();
}

let roadmapQueue: Promise<void> = Promise.resolve();

/** Runs `fn` after every board change queued before it. */
function inRoadmapQueue(fn: () => Promise<void>): Promise<void> {
  const run = roadmapQueue.then(fn);
  roadmapQueue = run.catch(() => undefined);
  return run;
}

const boardName = (state: State | undefined): string => state?.releases.roadmapName ?? 'The roadmap';

/** Writes the starter board where the board is to be (`.cockpit/` made first, with its `.gitignore`). */
async function createBoard(state: State, path: string, host: ActionHost): Promise<void> {
  const root = state.work.repoRoot ?? state.workspace?.path;
  if (root) await ensureCockpitDir(root);
  await mkdir(dirname(path), { recursive: true });
  const text = starterRoadmap(state.releases.currentVersion);
  await vscode.workspace.fs.writeFile(vscode.Uri.file(path), Buffer.from(text, 'utf8'));
  host.roadmapChanged(text);
}

async function editRoadmap(edit: RoadmapEdit, host: ActionHost): Promise<void> {
  const state = host.state();
  const path = state?.releases.roadmapPath;
  if (!state || !path) return refuse('Open a folder to keep a roadmap in.');
  const uri = vscode.Uri.file(path);

  if (edit.op === 'create') {
    if (existsSync(path)) return host.refreshGit();
    return createBoard(state, path, host);
  }
  if (!existsSync(path)) {
    refuse(`${boardName(state)} is gone.`);
    return host.refreshGit();
  }

  if (edit.op === 'remove') {
    const doc = await vscode.workspace.openTextDocument(uri);
    const item = parseRoadmap(doc.getText())
      .flatMap((lane) => lane.items)
      .find((i) => i.id === edit.id);
    const answer = item && (await vscode.window.showWarningMessage(`Delete "${item.text}" from the roadmap?`, { modal: true }, 'Delete'));
    if (item && answer !== 'Delete') return;
  }
  await changeRoadmap(path, (text) => applyRoadmapEdit(text, edit), host);
}

/** `cockpit add` and `cockpit lane`: the edit, on a board created first when there is none. */
async function agentEdit(edit: Extract<RoadmapEdit, { op: 'add' | 'addRelease' }>, host: ActionHost, ch: Channel): Promise<void> {
  const state = host.state();
  const path = state?.releases.roadmapPath;
  if (!state || !path) return ch.refuse('No folder is open to keep a roadmap in.');
  const created = !existsSync(path);
  if (created) await createBoard(state, path, host);
  if (!(await changeRoadmap(path, (text) => applyRoadmapEdit(text, edit), host, ch.refuse))) return;
  const did = edit.op === 'add' ? `added "${edit.text.replace(/\s+/g, ' ').trim()}" to ${edit.lane}` : `added the ${edit.version.replace(/^v/i, '')} lane`;
  await ch.tell(boardName(state), { ok: true, done: [...(created ? ['created the board'] : []), did] });
}

/** Changes the board's file at `path` through its document, not the file: a board open in an editor is edited as it
 *  stands there, and the change can be undone there. A change that cannot be made is refused (through `say`) and the
 *  board reloads. True when the file now holds the change. */
async function changeRoadmap(path: string, change: (text: string) => EditResult, host: ActionHost, say: (message: string) => void = refuse): Promise<boolean> {
  const uri = vscode.Uri.file(path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const before = doc.getText();
  const result = change(before);
  if (!result.ok) {
    say(result.error);
    host.roadmapChanged(before);
    return false;
  }
  const after = result.text;
  if (after === before) return true;
  // Only the span that differs, so an editor showing the file keeps its cursor and scroll position.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const span = new vscode.WorkspaceEdit();
  span.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(endBefore)), after.slice(start, endAfter));
  if (!(await vscode.workspace.applyEdit(span)) || !(await doc.save())) {
    say(`Could not write ${boardName(host.state())}.`);
    await host.refreshGit();
    return false;
  }
  host.roadmapChanged(doc.getText());
  return true;
}

/** Agent executable on the extension host PATH or a known installer directory. */
function findAgent(command: string): string | undefined {
  if (isAbsolute(command)) {
    try { accessSync(command, constants.X_OK); return statSync(command).isFile() ? command : undefined; } catch { return undefined; }
  }
  const names = process.platform === 'win32' ? [command, `${command}.exe`, `${command}.cmd`] : [command];
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'), join(homedir(), '.opencode', 'bin')];
  for (const dir of dirs.filter(Boolean)) {
    for (const name of names) {
      const path = join(dir, name);
      try {
        accessSync(path, constants.X_OK);
        if (statSync(path).isFile()) return path;
      } catch {
        // not here
      }
    }
  }
  return undefined;
}

/** A new terminal running claude on the cards, by the board's standard prompt. claude is the terminal's process
 *  and gets its arguments as an array, so no shell reads the card text. */
async function startAgent(ids: string[], options: LaunchOptions, host: ActionHost): Promise<void> {
  const state = host.state();
  const path = state?.releases.roadmapPath;
  if (!state || !path || !existsSync(path)) return refuse('There is no roadmap to start from.');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  const lanes = parseRoadmap(doc.getText());
  const found = ids.map((id) => lanes.flatMap((lane) => lane.items.map((item) => ({ item, lane }))).find((x) => x.item.id === id));
  const cards = found.filter((x) => x !== undefined);
  if (cards.length < ids.length) {
    refuse('The roadmap changed since the board last read it. Try again.');
    host.roadmapChanged(doc.getText());
    return;
  }
  const open = cards.filter((c) => c.item.status !== 'done');
  if (open.length === 0) return refuse(cards.length === 1 ? 'That card is done.' : 'Those cards are all done.');
  if (options.worktree && !state.work.available) return refuse('This folder is not a git repository, so the agent cannot have a worktree of its own. Untick "Own worktree".');
  const provider = providerFor(options.agent, state.settings.customAgents);
  if (!provider) return refuse('That agent is no longer configured. Choose another agent or update cockpit.agents.custom.');
  const executable = findAgent(provider.command);
  if (!executable) return refuse(`Cockpit could not find ${provider.command}. Install ${provider.label}, or start VS Code from a shell that has it on PATH.`);
  const claude = provider.id === 'claude';

  // The folder this window has open: the board may be in .cockpit/, or in another checkout.
  let cwd = state.workspace?.path ?? dirname(path);
  const launch: LaunchCard[] = open.map((c) => ({ text: c.item.text, lane: c.lane.version }));
  let worktree: string | undefined;
  if (options.worktree) {
    // Claude Code keeps worktrees in .claude/worktrees/<name>, on a branch "worktree-<name>".
    const root = state.work.repoRoot ?? cwd;
    const branches = new Set(state.work.items.map((i) => i.branch));
    const taken = (name: string) => existsSync(join(root, claude ? '.claude' : '.cockpit', 'worktrees', name)) || branches.has(`worktree-${name}`) || branches.has(name);
    const base = worktreeName(launch);
    worktree = base;
    for (let n = 2; taken(worktree); n++) worktree = `${base}-${n}`;
  }
  const project = state.workspace?.name ?? basename(cwd);
  if (worktree && !claude) {
    const root = state.work.repoRoot ?? cwd;
    await ensureCockpitDir(root);
    const folder = join(root, '.cockpit', 'worktrees', worktree);
    await mkdir(dirname(folder), { recursive: true });
    const added = await runGit(root, ['worktree', 'add', '-b', `worktree-${worktree}`, folder]);
    if (!added.ok) return refuse(`Could not create the agent worktree: ${added.stderr || added.stdout}`);
    cwd = folder;
  }
  const prompt = launchPrompt(launch, options, project, state.settings.promptSteps);
  const args = claude ? launchArgs(launch, options, project, worktree, state.settings.promptSteps) : agentLaunchArgs(provider, prompt, options);
  const processOptions = claude ? { shellPath: executable, shellArgs: args, env: launchEnv(options) } : managedTerminal(executable, args, { provider: provider.id, cwd, title: sessionName(launch), prompt });
  const terminal = vscode.window.createTerminal({
    name: `${provider.label}: ${sessionName(launch)}`,
    cwd,
    ...processOptions,
    iconPath: new vscode.ThemeIcon('sparkle'),
  });
  terminal.show(false);

  // Each card is linked to the session's branch and, when asked, moved to In progress. One edit per card, each on
  // its own line: the ids of the others stay valid.
  const branch = worktree ? `worktree-${worktree}` : undefined;
  for (const c of open) {
    const doing = options.markDoing && c.item.status === 'todo' ? 'doing' : undefined;
    if (branch) await changeRoadmap(path, (text) => linkCard(text, c.item.id, branch, doing), host);
    else if (doing) await editRoadmap({ op: 'setStatus', id: c.item.id, status: doing }, host);
  }
}

// ───────────────────────────── Ship, Release, Tag, Pull ─────────────────────────────
// Each follows state.work.delivery: `pr` publishes through GitHub, `direct` merges and releases in the main checkout
// (pushing too when there is an origin, which only an explicit "delivery": "direct" gives). Cockpit never commits the
// board on a branch; a direct release commits it with the release when git tracks it.

/** Where an action's words go. The board: VS Code's messages and dialogs. The `cockpit` command: lines it prints. */
interface Channel {
  via: 'board' | 'cli';
  refuse(message: string): void;
  tell(what: string, outcome: Outcome): Promise<void>;
}

const boardChannel: Channel = { via: 'board', refuse: (m) => refuse(m), tell: (w, o) => tell(w, o) };

/** The lines `cockpit` prints. ok: something was done and nothing was refused or failed. */
function cliChannel(): Channel & { result(): AgentResult } {
  const lines: string[] = [];
  let failed = false;
  let told = false;
  return {
    via: 'cli',
    refuse(message) {
      failed = true;
      lines.push(message);
    },
    async tell(what, outcome) {
      told = true;
      if (outcome.ok) {
        lines.push(`${what}: ${outcome.done.join(', ')}.`);
        return;
      }
      failed = true;
      lines.push(`${what} stopped. ${outcome.error ?? ''}`.trim());
      lines.push(outcome.done.length ? `Done before it stopped: ${outcome.done.join('; ')}.` : 'Nothing was changed.');
    },
    result: () => (lines.length ? { ok: told && !failed, lines } : { ok: false, lines: ['Cockpit did nothing: it has not read this repository yet.'] }),
  };
}

/** Asks before an action: always from the board; from `cockpit` only when it leaves the machine (a push, a pull
 *  request, a pushed tag). A cancelled dialog is said back to `cockpit`. */
async function confirm(ch: Channel, leavesMachine: boolean, title: string, detail: string, go: string): Promise<boolean> {
  if (ch.via === 'cli' && !leavesMachine) return true;
  if ((await vscode.window.showWarningMessage(title, { modal: true, detail }, go)) === go) return true;
  if (ch.via === 'cli') ch.refuse(`${title} Cancelled in VS Code: nothing was done.`);
  return false;
}

interface Checkout {
  repoRoot: string;
  base: string;
  /** The board's file, when it exists. */
  roadmap?: string;
  /** The board's file from the root: ".cockpit/roadmap.md", "ROADMAP.md". */
  name: string;
}

/** These run on the main checkout (repoRoot), whatever worktree the window has open: the board is the repository's,
 *  and its default branch is what they deliver into. A string says why not. */
function mainCheckout(state: State): Checkout | string {
  const { repoRoot, defaultBranch: base } = state.work;
  if (!repoRoot || !base) return 'No git repository with a default branch is open.';
  const path = state.releases.roadmapPath;
  const name = state.releases.roadmapName ?? 'The roadmap';
  return path && existsSync(path) ? { repoRoot, base, roadmap: path, name } : { repoRoot, base, name };
}

/** Why GitHub cannot be published to, or undefined. */
async function publishProblem(state: State, repoRoot: string): Promise<string | undefined> {
  if (!state.work.github) return `GitHub is not available here${state.work.githubNote ? ` (${state.work.githubNote})` : ''}: Cockpit publishes through gh.`;
  return remoteProblem(repoRoot);
}

const roadmapNow = async (path: string): Promise<string> => (await vscode.workspace.openTextDocument(vscode.Uri.file(path))).getText();

/** The board's text, refused while it has unsaved edits in an editor: those are not on disk, and would be committed
 *  unseen. */
async function savedRoadmap(path: string, name: string, ch: Channel): Promise<string | undefined> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  if (!doc.isDirty) return doc.getText();
  ch.refuse(`${name} has unsaved changes in an editor. Save it first.`);
  return undefined;
}

/** A body in a dialog: its start, when it is long. */
const PREVIEW_CHARS = 1500;
const preview = (body: string): string => (body.length > PREVIEW_CHARS ? `${body.slice(0, PREVIEW_CHARS)}…\n(and ${body.length - PREVIEW_CHARS} more characters)` : body || '(empty)');

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Today in the local time zone, as a changelog dates a release. */
function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const progress = <T>(title: string, task: () => Promise<T>): Promise<T> =>
  Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Cockpit: ${title}` }, task));

/** What happened: a short note with a link to the pull request, or a dialog saying where it stopped and what was done. */
async function tell(what: string, outcome: Outcome): Promise<void> {
  if (outcome.ok) {
    const url = outcome.url && isHttpsUrl(outcome.url) ? outcome.url : undefined;
    const open = 'Open pull request';
    const answer = await vscode.window.showInformationMessage(`${what}: ${outcome.done.join(', ')}.`, ...(url ? [open] : []));
    if (url && answer === open) await vscode.env.openExternal(vscode.Uri.parse(url, true));
    return;
  }
  const detail = outcome.done.length ? `Done before it stopped: ${outcome.done.join('; ')}.` : 'Nothing was changed.';
  void vscode.window.showErrorMessage(`${what} stopped. ${outcome.error ?? ''}`, { modal: true, detail });
}

/** Finishes a branch. `pr`: pushes it and opens its pull request, after a confirmation that shows the title and the
 *  body; its cards are marked done by the Pull after the merge. `direct`: merges it into the default branch in the
 *  main checkout, then marks its cards done on the board. */
async function ship(branch: string, host: ActionHost, ch: Channel = boardChannel, opts: { self?: boolean } = {}): Promise<void> {
  await host.refreshLocal();
  const state = host.state();
  if (!state) return;
  const at = mainCheckout(state);
  if (typeof at === 'string') return ch.refuse(at);
  const item = state.work.items.find((i) => i.branch === branch);
  if (!item) return ch.refuse(`${branch} is no longer a branch here.`);
  const problem = shipProblem(item, state, opts);
  if (problem) return ch.refuse(problem);
  const cards: ShippedCard[] = state.releases.roadmap.flatMap((l) => l.items.filter((i) => i.branch === branch).map((i) => ({ text: i.text, lane: l.version })));
  if (state.work.delivery === 'direct') return shipDirect(branch, cards, at, state, host, ch);

  const remote = await remoteProblem(at.repoRoot);
  if (remote) return ch.refuse(remote);
  const listed = await prsFrom(runGh, at.repoRoot, branch);
  if (!listed.ok) return ch.refuse(listed.error);
  const existing = listed.prs.find((p) => p.state !== 'closed');
  if (existing) return ch.refuse(`${branch} already has pull request #${existing.number} (${existing.state}).`);

  const report = item.sessionIds.map((id) => state.sessions[id]?.report).find(Boolean);
  const title = prTitle(cards, item.lastCommitSubject ?? branch);
  const body = prBody(cards, report);
  const detail = [
    `Pushes ${branch} to ${REMOTE} and opens a pull request into ${at.base}.`,
    cards.length ? `Once it merges, Pull marks ${plural(cards.length, 'card')} done on the board.` : '',
    `Title: ${title}`,
    `Body:\n${preview(body)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!(await confirm(ch, true, `Ship ${branch}?`, detail, 'Push and open PR'))) return;
  const outcome = await progress(`shipping ${branch}…`, () =>
    shipBranch({ repoRoot: at.repoRoot, ...(item.worktreePath ? { worktree: item.worktreePath } : {}), branch, base: at.base, title, body }, runGh),
  );
  await host.refresh();
  await ch.tell(`Ship ${branch}`, outcome);
}

async function shipDirect(branch: string, cards: ShippedCard[], at: Checkout, state: State, host: ActionHost, ch: Channel): Promise<void> {
  const push = state.work.hasOrigin;
  const detail = [
    `Merges ${branch} into ${at.base} in the main checkout (${at.repoRoot}), as a fast-forward when it can be one${push ? `, then pushes ${at.base} to ${REMOTE}` : ''}.`,
    cards.length ? `Then ${cards.length === 1 ? 'its card is' : `its ${cards.length} cards are`} marked done on the board: ${cards.map((c) => `"${c.text}"`).join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!(await confirm(ch, push, `Merge ${branch} into ${at.base}?`, detail, push ? 'Merge and push' : 'Merge'))) return;
  const outcome = await progress(`merging ${branch}…`, () => mergeBranch({ repoRoot: at.repoRoot, branch, base: at.base, push }));
  // Merged, even when the push after it failed: the cards are done.
  const merged = outcome.done.length > 0;
  if (merged && cards.length && at.roadmap) {
    const path = at.roadmap;
    let finished = false;
    await inRoadmapQueue(async () => {
      finished = await changeRoadmap(path, (text) => ({ ok: true, text: finishBranch(text, branch) }), host, ch.refuse);
    });
    if (finished) outcome.done.push(`marked ${plural(cards.length, 'card')} done on the board`);
  }
  await host.refresh();
  await ch.tell(`Ship ${branch}`, outcome);
}

/** Releases a lane whose cards are all done. `pr`: the release pull request (the version bumped and the changelog
 *  dated), on a new branch from the up-to-date default branch, in a temporary worktree. `direct`: the release commit
 *  on the default branch in the main checkout, and its tag, in one step. */
async function release(version: string, host: ActionHost, ch: Channel = boardChannel): Promise<void> {
  await host.refreshLocal();
  const state = host.state();
  if (!state) return;
  const at = mainCheckout(state);
  if (typeof at === 'string') return ch.refuse(at);
  const lane = state.releases.roadmap.find((l) => !l.backlog && l.version === version);
  if (!lane || !at.roadmap) return ch.refuse(`${at.name} has no ${version} release.`);
  const step = releaseStep(lane, state);
  if (step?.step !== 'release') {
    if (step?.step === 'review') return ch.refuse(`The release pull request #${step.pr.number} is open already.`);
    if (step?.step === 'tag') return ch.refuse(state.work.delivery === 'direct' ? `${version} is shipped already: tag it.` : `${version} merged already: tag it.`);
    return ch.refuse(`${version} is not ready to release: every card in it has to be done.`);
  }
  if (state.work.delivery === 'direct') return releaseDirect(version, at, at.roadmap, state, host, ch);

  const problem = await publishProblem(state, at.repoRoot);
  if (problem) return ch.refuse(problem);
  const branch = releaseBranch(version);
  const listed = await prsFrom(runGh, at.repoRoot, branch);
  if (!listed.ok) return ch.refuse(listed.error);
  const existing = listed.prs.find((p) => p.state !== 'closed');
  if (existing) return ch.refuse(`${branch} already has pull request #${existing.number} (${existing.state}).`);
  const drafted = await progress(`preparing ${version}…`, () =>
    draftRelease({ repoRoot: at.repoRoot, base: at.base, version, versionFiles: state.settings.releaseVersionFiles, date: today() }),
  );
  if (!drafted.ok) return ch.refuse(drafted.error);
  const { draft } = drafted;
  const title = releaseTitle(version);
  const body = releaseBody(lane, draft.notes);
  const local = state.work.items.find((i) => i.isDefault)?.ahead ?? 0;
  const detail = [
    `Opens a pull request into ${at.base} from a new branch ${branch}, made from ${REMOTE}/${at.base} (${draft.baseSha.slice(0, 7)}) in a temporary worktree. This checkout is not touched.`,
    draft.files.map((f) => `${f.path}: ${f.change}`).join('\n'),
    local ? `${plural(local, 'commit')} on your local ${at.base} ${local === 1 ? 'is' : 'are'} not on ${REMOTE}, and not part of this release.` : '',
    `Title: ${title}`,
    `Body:\n${preview(body)}`,
    `Once it merges, Pull marks ${version} shipped on the board, and the lane offers to tag ${tagName(version)}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!(await confirm(ch, true, `Release ${version}?`, detail, 'Open release PR'))) return;
  const outcome = await progress(`opening the ${version} pull request…`, () => openRelease(draft, title, body, runGh));
  await host.refresh();
  await ch.tell(`Release ${version}`, outcome);
}

async function releaseDirect(version: string, at: Checkout, path: string, state: State, host: ActionHost, ch: Channel): Promise<void> {
  const push = state.work.hasOrigin;
  const drafted = await progress(`preparing ${version}…`, () =>
    draftDirect({ repoRoot: at.repoRoot, base: at.base, version, versionFiles: state.settings.releaseVersionFiles, date: today(), remote: push }),
  );
  if (!drafted.ok) return ch.refuse(drafted.error);
  const { draft } = drafted;
  // A board git tracks goes into the release commit, shipped; one it does not is marked shipped once the commit is made.
  let before: string | undefined;
  let roadmap: { path: string; text: string; originalText?: string } | undefined;
  if (await isTracked(at.repoRoot, at.name)) {
    before = await savedRoadmap(path, at.name, ch);
    if (before === undefined) return;
    const shipped = setLaneStatus(before, version, 'shipped');
    if (!shipped.ok) return ch.refuse(shipped.error);
    roadmap = { path: at.name, text: shipped.text, originalText: before };
  }
  const tag = tagName(version);
  const detail = [
    `Commits "${releaseTitle(version)}" on ${at.base} in the main checkout (${at.repoRoot}), with these files only, and tags it ${tag}${push ? `; then pushes ${at.base} and ${tag} to ${REMOTE} together` : ''}.`,
    [...draft.files.map((f) => `${f.path}: ${f.change}`), ...(roadmap ? [`${at.name}: ${version}: Status: shipped`] : [])].join('\n'),
    roadmap ? '' : `${at.name} is not in git: ${version} is marked shipped on it once the commit is made.`,
    draft.notes.length ? `Changelog:\n${preview(draft.notes.map((n) => `- ${n}`).join('\n'))}` : '',
    push ? 'A pushed tag may deploy: release workflows often start on a new tag.' : '',
  ]
    .filter(Boolean)
    .join('\n\n');
  if (!(await confirm(ch, push, `Release ${version}?`, detail, push ? `Release and push ${tag}` : 'Release'))) return;
  if (roadmap && (await roadmapNow(path)) !== before) return ch.refuse(`${at.name} changed while the confirmation was open. Release again to see it as it is now.`);
  const outcome = await progress(`releasing ${version}…`, () => commitRelease(draft, { ...(roadmap ? { roadmap } : {}), push }));
  const committed = outcome.done.length > 0;
  if (committed && roadmap) host.roadmapChanged(roadmap.text);
  if (committed && !roadmap) {
    let shipped = false;
    await inRoadmapQueue(async () => {
      shipped = await changeRoadmap(path, (text) => setLaneStatus(text, version, 'shipped'), host, ch.refuse);
    });
    if (shipped) outcome.done.push(`marked ${version} shipped on the board`);
  }
  await host.refresh();
  await ch.tell(`Release ${version}`, outcome);
}

/** Tags a release that has none yet. `pr`: the commit the release pull request merged as, and pushes the tag.
 *  `direct`: the default branch's tip, for a lane that says shipped, pushed when there is an origin. A tag that is
 *  pushed asks first, with a word that it may deploy. */
async function tag(version: string, host: ActionHost, ch: Channel = boardChannel): Promise<void> {
  const state = host.state();
  if (!state) return;
  const at = mainCheckout(state);
  if (typeof at === 'string') return ch.refuse(at);
  const direct = state.work.delivery === 'direct';
  const lane = state.releases.roadmap.find((l) => !l.backlog && l.version === version);
  if (!lane || releaseStep(lane, state)?.step !== 'tag') return ch.refuse(direct ? `${version} is not shipped yet, or is tagged already.` : `${version} is not merged yet, or is tagged already.`);
  const name = tagName(version);
  if (direct) {
    const push = state.work.hasOrigin;
    const found = await findDirectTag(at.repoRoot, at.base, version, push);
    if (!found.ok) return ch.refuse(found.error);
    const detail = `Tags ${found.sha.slice(0, 7)}, the tip of ${at.base}, as ${name} (an annotated tag, "${releaseTitle(version)}")${push ? `, and pushes the tag to ${REMOTE}.\n\nA pushed tag may deploy: release workflows often start on a new tag.` : '.'}`;
    if (!(await confirm(ch, push, push ? `Tag ${name} and push it?` : `Tag ${name}?`, detail, push ? `Tag and push ${name}` : `Tag ${name}`))) return;
    const outcome = await progress(`tagging ${name}…`, () => pushTag(at.repoRoot, version, found.sha, push));
    await host.refresh();
    await ch.tell(`Tag ${name}`, outcome);
    return;
  }
  const problem = await publishProblem(state, at.repoRoot);
  if (problem) return ch.refuse(problem);
  const found = await progress(`finding the ${version} merge…`, () => findRelease(runGh, at.repoRoot, at.base, version));
  if (!found.ok) return ch.refuse(found.error);
  const detail = `Tags ${found.sha.slice(0, 7)}, the merge of the release pull request #${found.pr} into ${at.base}, as ${name} (an annotated tag, "${releaseTitle(version)}"), and pushes the tag to ${REMOTE}.\n\nA pushed tag may deploy: release workflows often start on a new tag. Cockpit never tags on its own.`;
  if (!(await confirm(ch, true, `Tag ${name} and push it?`, detail, `Tag and push ${name}`))) return;
  const outcome = await progress(`tagging ${name}…`, () => pushTag(at.repoRoot, version, found.sha));
  await host.refresh();
  await ch.tell(`Tag ${name}`, outcome);
}

/** Brings the main checkout up to date after a merge on GitHub: the board first reads as the merge has it (the
 *  merged branches' cards done, the merged releases shipped), then the default branch is pulled. */
async function pull(host: ActionHost, ch: Channel = boardChannel): Promise<void> {
  const state = host.state();
  if (!state) return;
  const at = mainCheckout(state);
  if (typeof at === 'string') return ch.refuse(at);
  if (!state.work.hasOrigin) return ch.refuse(`This repository has no ${REMOTE} to pull from.`);
  if (!state.work.items.some((i) => i.isDefault && i.worktreePath === at.repoRoot)) return ch.refuse(`The main checkout is not on ${at.base}: switch to it to pull.`);
  if (!(await syncMerged(host, ch))) return;
  const outcome = await progress(`pulling ${at.base}…`, () => pullDefault(at.repoRoot));
  await host.refreshLocal();
  if (outcome.ok && ch.via === 'board') vscode.window.setStatusBarMessage(`Cockpit: ${at.base} ${outcome.done.join(', ')}`, 4000);
  else await ch.tell(`Pull ${at.base}`, outcome);
}

/** Makes the board read as what merged (publish.ts withMerged marks it in the State): the cards of a branch whose pull
 *  request merged are done and unlinked, and a release whose pull request merged is shipped. False, after saying why,
 *  when the pull is not to go ahead: the board has unsaved edits in an editor, or could not be written. */
async function syncMerged(host: ActionHost, ch: Channel): Promise<boolean> {
  const state = host.state();
  const at = state && mainCheckout(state);
  if (!state || !at || typeof at === 'string' || !at.roadmap) return true;
  const work = mergedWork(state.releases.roadmap);
  if (work.branches.length === 0 && work.versions.length === 0) return true;
  const path = at.roadmap;
  const name = at.name;
  let synced = false;
  await inRoadmapQueue(async () => {
    if ((await savedRoadmap(path, name, ch)) === undefined) return;
    synced = await changeRoadmap(path, (text) => ({ ok: true, text: finishMerged(text, work) }), host, ch.refuse);
  });
  return synced;
}

function refuse(message: string): void {
  void vscode.window.showWarningMessage(message);
}

function focus(session: ClaudeSession, host: ActionHost): void {
  const terminal = host.terminalFor(session.sessionId);
  if (!terminal) return refuse('This agent is not running in a terminal of this window.');
  terminal.show(false);
}

function resume(session: ClaudeSession, host: ActionHost): void {
  if (session.live) {
    if (host.terminalFor(session.sessionId)) return focus(session, host);
    return refuse(`"${session.title}" is already running${session.pid ? ` (pid ${session.pid})` : ''}. Focus its existing terminal.`);
  }
  const state = host.state();
  const provider = providerFor(session.provider, state?.settings.customAgents);
  const nativeId = session.nativeSessionId ?? session.sessionId;
  if (session.canResume === false || !provider?.resumeArgs) return refuse('This agent does not expose a resumable session. Start a new agent on its roadmap card.');
  if (!(provider.id === 'claude' ? isSessionId(nativeId) : isNativeSessionId(nativeId))) return refuse('That native session id looks wrong; not resuming it.');
  if (!session.cwd || !existsSync(session.cwd)) return refuse(`The folder this session ran in${session.cwd ? ` (${session.cwd})` : ''} is gone.`);
  const executable = findAgent(provider.command);
  if (!executable) return refuse(`Cockpit could not find ${provider.command} on PATH.`);
  const args = providerArgs(provider, { sessionId: nativeId }, true)!;
  const processOptions = provider.id === 'claude' ? { shellPath: executable, shellArgs: args } : managedTerminal(executable, args, { provider: provider.id, cwd: session.cwd, title: session.title, nativeSessionId: nativeId });
  const terminal = vscode.window.createTerminal({ name: `${provider.label}: ${session.title.slice(0, 40)}`, cwd: session.cwd, ...processOptions, iconPath: new vscode.ThemeIcon('sparkle') });
  terminal.show(false);
}

async function openTranscript(session: ClaudeSession): Promise<void> {
  const path = session.transcriptPath;
  if (!path || !existsSync(path)) return refuse('This session has no transcript on disk.');
  const uri = vscode.Uri.file(path);
  if (statSync(path).size > MAX_TRANSCRIPT_EDITOR_BYTES) {
    await vscode.commands.executeCommand('revealFileInOS', uri);
    return;
  }
  await vscode.window.showTextDocument(uri, { preview: true, viewColumn: vscode.ViewColumn.Beside });
}

/** One line of the confirmation: the branch, its worktree, and the ended sessions that could not resume after. */
function describe(i: WorkItem): string {
  const parts = [i.branch];
  if (i.worktreePath) parts.push(`worktree ${i.worktreePath}`);
  if (i.worktreePath && i.sessionIds.length) parts.push(`${i.sessionIds.length} ended agent session${i.sessionIds.length === 1 ? '' : 's'} ran there`);
  return parts.join('  ·  ');
}

interface CleanPlan {
  repoRoot: string;
  defaultBranch: string;
  items: WorkItem[];
  /** Merged on the board through their PR, but not by git's measure. */
  squashMerged: WorkItem[];
}

/** Decides on fresh sessions and git, never on a State that may be a minute old. */
async function planClean(host: ActionHost): Promise<CleanPlan | undefined> {
  await host.refreshLocal();
  const state = host.state();
  const repoRoot = state?.work.repoRoot;
  const defaultBranch = state?.work.defaultBranch;
  if (!state || !repoRoot || !defaultBranch) return undefined;
  const folders = [...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), ...host.otherWindowFolders()];
  const items = cleanCandidates(state, folders);
  const squashMerged = state.work.items.filter((i) => i.group === 'merged' && !i.isDefault && i.ahead > 0);
  return { repoRoot, defaultBranch, items, squashMerged };
}

const itemKey = (i: WorkItem) => `${i.branch}\0${i.worktreePath ?? ''}`;

async function cleanMerged(host: ActionHost): Promise<void> {
  const plan = await planClean(host);
  if (!plan) return refuse('No git repository is open.');
  const { items, repoRoot, defaultBranch } = plan;
  const squashNote = plan.squashMerged.length
    ? `${plan.squashMerged.length} squash-merged branch${plan.squashMerged.length === 1 ? ' is' : 'es are'} left alone: ${defaultBranch} has their changes but not their commits, so git cannot confirm it. Delete ${plan.squashMerged.length === 1 ? 'it' : 'them'} by hand once you are sure.`
    : '';
  if (items.length === 0) {
    const nothing = 'Nothing to clean: no merged branch is clean, unused and free of live agents.';
    void (squashNote ? vscode.window.showInformationMessage(nothing, { modal: true, detail: squashNote }) : vscode.window.showInformationMessage(nothing));
    return;
  }
  const worktrees = items.filter((i) => i.worktreePath).length;
  const detail = [
    `Removes ${worktrees} worktree${worktrees === 1 ? '' : 's'} with "git worktree remove" and deletes ${items.length} branch${items.length === 1 ? '' : 'es'} whose commits are all in ${defaultBranch}. Each branch is checked again before anything of it is removed, and git keeps any worktree with uncommitted or untracked changes.`,
    worktrees ? 'Ignored files in those worktrees (node_modules, .venv, build output, ignored data folders) are deleted with them.' : '',
    squashNote,
    items.map(describe).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');
  const go = `Remove ${items.length}`;
  const answer = await vscode.window.showWarningMessage(`Clean ${items.length} merged branch${items.length === 1 ? '' : 'es'}?`, { modal: true, detail }, go);
  if (answer !== go) return;

  // The dialog may have stayed open while a Claude started in one of these worktrees: decide again, and act only on
  // what is still a candidate and was confirmed.
  const fresh = await planClean(host);
  const stillOk = new Set((fresh?.repoRoot === repoRoot ? fresh.items : []).map(itemKey));
  const { removed, kept } = await removeMerged(repoRoot, items, (i) => !stillOk.has(itemKey(i)));
  await host.refreshGit();

  const lines = [removed.length ? `Removed:\n${removed.join('\n')}` : 'Nothing was removed.', kept.length ? `Kept:\n${kept.join('\n')}` : ''].filter(Boolean);
  const summary = `Cleaned ${removed.length} of ${items.length}.`;
  void vscode.window.showInformationMessage(summary, { modal: true, detail: lines.join('\n\n') });
}
