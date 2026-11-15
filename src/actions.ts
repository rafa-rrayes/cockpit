// Every message the webview can post, handled here. The webview is treated as untrusted input: each message is
// checked against the current State (known session ids, known paths, links it shows) before anything happens, and
// nothing changes on disk except through cleanMerged, which lists what it would do and asks first, and through the
// roadmap board, which edits ROADMAP.md and nothing else, and through the settings popover, which writes cockpit.*
// settings only, each value checked against what its setting takes. Starting a Claude on cards opens a terminal; the Claude
// it runs is then the one that changes things, in the terminal, under its own permission prompts. Ship, Release and Tag
// reach outside the machine: each shows what it will send and does nothing until the person confirms.
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { markOf, shipProblem } from './catchup';
import { removeMerged } from './clean';
import { runGh } from './data/github';
import { type EditResult, applyRoadmapEdit, finishBranch, linkCard, parseRoadmap, setLaneStatus, starterRoadmap } from './data/roadmap';
import { cleanCandidates, isHttpsUrl, isSessionId, knownFolders, knownUrls, parseMessage } from './guards';
import { type LaunchCard, launchArgs, launchEnv, sessionName, worktreeName } from './launch';
import type { CatchUpMark, ClaudeSession, LaunchOptions, RoadmapEdit, State, WorkItem } from './model';
import { type ShippedCard, mergedWork, prBody, prTitle, releaseBody, releaseBranch, releaseStep, releaseTitle, roadmapCommitMessage, tagName } from './publish';
import { isProjectSetting, storedValue } from './settings';
import { type Outcome, REMOTE, draftRelease, findRelease, openRelease, prsFrom, pullDefault, pushTag, remoteProblem, shipBranch } from './ship';

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
    case 'toggleMaximize':
      await vscode.commands.executeCommand('workbench.action.toggleZenMode');
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
    case 'startClaude':
      // In the roadmap queue: the cards are read as the edits before left the file, and marking them follows.
      return inRoadmapQueue(() => startClaude(msg.ids, msg.options, host));
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
      if (!path || !existsSync(path)) return refuse('There is no ROADMAP.md yet.');
      await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false, viewColumn: vscode.ViewColumn.Beside });
      return;
    }
  }
}

let roadmapQueue: Promise<void> = Promise.resolve();

/** Runs `fn` after every ROADMAP.md change queued before it. */
function inRoadmapQueue(fn: () => Promise<void>): Promise<void> {
  const run = roadmapQueue.then(fn);
  roadmapQueue = run.catch(() => undefined);
  return run;
}

async function editRoadmap(edit: RoadmapEdit, host: ActionHost): Promise<void> {
  const releases = host.state()?.releases;
  const path = releases?.roadmapPath;
  if (!releases || !path) return refuse('Open a folder to keep a roadmap in.');
  const uri = vscode.Uri.file(path);

  if (edit.op === 'create') {
    if (existsSync(path)) return host.refreshGit();
    const text = starterRoadmap(releases.currentVersion);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
    host.roadmapChanged(text);
    return;
  }
  if (!existsSync(path)) {
    refuse('ROADMAP.md is gone.');
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

/** Changes ROADMAP.md at `path` through its document, not the file: a ROADMAP.md open in an editor is edited as it
 *  stands there, and the change can be undone there. A change that cannot be made is refused and the board
 *  reloads. True when the file now holds the change. */
async function changeRoadmap(path: string, change: (text: string) => EditResult, host: ActionHost): Promise<boolean> {
  const uri = vscode.Uri.file(path);
  const doc = await vscode.workspace.openTextDocument(uri);
  const before = doc.getText();
  const result = change(before);
  if (!result.ok) {
    refuse(result.error);
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
    refuse('Could not write ROADMAP.md.');
    await host.refreshGit();
    return false;
  }
  host.roadmapChanged(doc.getText());
  return true;
}

/** `claude` on the PATH the extension host has, or where its installer puts it. */
function findClaude(): string | undefined {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  const dirs = [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local')];
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
async function startClaude(ids: string[], options: LaunchOptions, host: ActionHost): Promise<void> {
  const state = host.state();
  const path = state?.releases.roadmapPath;
  if (!state || !path || !existsSync(path)) return refuse('There is no ROADMAP.md to start from.');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  const lanes = parseRoadmap(doc.getText());
  const found = ids.map((id) => lanes.flatMap((lane) => lane.items.map((item) => ({ item, lane }))).find((x) => x.item.id === id));
  const cards = found.filter((x) => x !== undefined);
  if (cards.length < ids.length) {
    refuse('ROADMAP.md changed since the board last read it. Try again.');
    host.roadmapChanged(doc.getText());
    return;
  }
  const open = cards.filter((c) => c.item.status !== 'done');
  if (open.length === 0) return refuse(cards.length === 1 ? 'That card is done.' : 'Those cards are all done.');
  if (options.worktree && !state.work.available) return refuse('This folder is not a git repository, so the Claude cannot have a worktree of its own. Untick "Own worktree".');
  const claude = findClaude();
  if (!claude) return refuse('Cockpit could not find `claude` on the PATH. Install Claude Code, or start VS Code from a shell that has it.');

  const cwd = dirname(path);
  const launch: LaunchCard[] = open.map((c) => ({ text: c.item.text, lane: c.lane.version }));
  let worktree: string | undefined;
  if (options.worktree) {
    // Claude Code keeps worktrees in .claude/worktrees/<name>, on a branch "worktree-<name>".
    const root = state.work.repoRoot ?? cwd;
    const branches = new Set(state.work.items.map((i) => i.branch));
    const taken = (name: string) => existsSync(join(root, '.claude', 'worktrees', name)) || branches.has(`worktree-${name}`) || branches.has(name);
    const base = worktreeName(launch);
    worktree = base;
    for (let n = 2; taken(worktree); n++) worktree = `${base}-${n}`;
  }
  const project = state.workspace?.name ?? basename(cwd);
  const terminal = vscode.window.createTerminal({
    name: `Claude: ${sessionName(launch)}`,
    cwd,
    shellPath: claude,
    shellArgs: launchArgs(launch, options, project, worktree, state.settings.promptSteps),
    env: launchEnv(options),
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

interface Checkout {
  repoRoot: string;
  base: string;
  /** The main checkout's ROADMAP.md, when it has one. */
  roadmap?: string;
}

/** These run from the main checkout only: its ROADMAP.md is the board's, and its default branch is what they publish
 *  into. A string says why not. */
function mainCheckout(state: State): Checkout | string {
  const { repoRoot, defaultBranch: base } = state.work;
  if (!repoRoot || !base) return 'No git repository with a default branch is open.';
  const path = state.releases.roadmapPath;
  if (path !== join(repoRoot, 'ROADMAP.md')) return `Open the main checkout (${repoRoot}) for this: its ROADMAP.md is the board's.`;
  return existsSync(path) ? { repoRoot, base, roadmap: path } : { repoRoot, base };
}

/** Why GitHub cannot be published to, or undefined. */
async function publishProblem(state: State, repoRoot: string): Promise<string | undefined> {
  if (!state.work.github) return `GitHub is not available here${state.work.githubNote ? ` (${state.work.githubNote})` : ''}: Cockpit publishes through gh.`;
  return remoteProblem(repoRoot);
}

const roadmapNow = async (path: string): Promise<string> => (await vscode.workspace.openTextDocument(vscode.Uri.file(path))).getText();

/** The board's text, refused while it has unsaved edits in an editor: those are not on disk, and would go out unseen. */
async function savedRoadmap(path: string): Promise<string | undefined> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  if (!doc.isDirty) return doc.getText();
  refuse('ROADMAP.md has unsaved changes in an editor. Save it first.');
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

/** Pushes a finished branch and opens its pull request, after a confirmation that shows the title and the body. The
 *  board travels with it: ROADMAP.md as the main checkout has it, the branch's cards ticked and unlinked, is
 *  committed on the branch, so the merge brings it to the default branch and the main checkout never commits. */
async function ship(branch: string, host: ActionHost): Promise<void> {
  await host.refreshLocal();
  const state = host.state();
  if (!state) return;
  const at = mainCheckout(state);
  if (typeof at === 'string') return refuse(at);
  const item = state.work.items.find((i) => i.branch === branch);
  if (!item) return refuse(`${branch} is no longer a branch here.`);
  const problem = shipProblem(item, state) ?? (await remoteProblem(at.repoRoot));
  if (problem) return refuse(problem);
  const worktree = item.worktreePath as string;
  const listed = await prsFrom(runGh, at.repoRoot, branch);
  if (!listed.ok) return refuse(listed.error);
  const existing = listed.prs.find((p) => p.state !== 'closed');
  if (existing) return refuse(`${branch} already has pull request #${existing.number} (${existing.state}).`);

  const cards: ShippedCard[] = state.releases.roadmap.flatMap((l) => l.items.filter((i) => i.branch === branch).map((i) => ({ text: i.text, lane: l.version })));
  let before: string | undefined;
  if (at.roadmap) {
    before = await savedRoadmap(at.roadmap);
    if (before === undefined) return;
  }
  const roadmap = before === undefined ? undefined : finishBranch(before, branch);
  const report = item.sessionIds.map((id) => state.sessions[id]?.report).find(Boolean);
  const title = prTitle(cards, item.lastCommitSubject ?? branch);
  const body = prBody(cards, report);
  const go = 'Push and open PR';
  const detail = [
    `Pushes ${branch} to ${REMOTE} and opens a pull request into ${at.base}.`,
    roadmap === undefined
      ? ''
      : `First it commits ROADMAP.md on the branch as the board has it now${cards.length ? `, with ${plural(cards.length, 'card')} done` : ''}; if ${at.base}'s ROADMAP.md changed since the branch started, ${REMOTE}/${at.base} is merged into the branch before that. This checkout's ROADMAP.md stays as it is until the pull request merges.`,
    `Title: ${title}`,
    `Body:\n${preview(body)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
  if ((await vscode.window.showWarningMessage(`Ship ${branch}?`, { modal: true, detail }, go)) !== go) return;
  if (at.roadmap && (await roadmapNow(at.roadmap)) !== before) return refuse('ROADMAP.md changed while the confirmation was open. Ship again to see it as it is now.');
  const outcome = await progress(`shipping ${branch}…`, () =>
    shipBranch({ worktree, branch, base: at.base, roadmap, commitMessage: roadmapCommitMessage(cards), title, body }, runGh),
  );
  await host.refresh();
  await tell(`Ship ${branch}`, outcome);
}

/** The release pull request of a lane whose cards are all done: the version bumped, the changelog dated and the lane
 *  shipped, on a new branch from the up-to-date default branch, in a temporary worktree. */
async function release(version: string, host: ActionHost): Promise<void> {
  await host.refreshLocal();
  const state = host.state();
  if (!state) return;
  const at = mainCheckout(state);
  if (typeof at === 'string') return refuse(at);
  const lane = state.releases.roadmap.find((l) => !l.backlog && l.version === version);
  if (!lane || !at.roadmap) return refuse(`ROADMAP.md has no ${version} release.`);
  const step = releaseStep(lane, state);
  if (step?.step !== 'release') {
    if (step?.step === 'review') return refuse(`The release pull request #${step.pr.number} is open already.`);
    return refuse(step?.step === 'tag' ? `${version} merged already: tag it.` : `${version} is not ready to release: every card in it has to be done.`);
  }
  const problem = await publishProblem(state, at.repoRoot);
  if (problem) return refuse(problem);
  const branch = releaseBranch(version);
  const listed = await prsFrom(runGh, at.repoRoot, branch);
  if (!listed.ok) return refuse(listed.error);
  const existing = listed.prs.find((p) => p.state !== 'closed');
  if (existing) return refuse(`${branch} already has pull request #${existing.number} (${existing.state}).`);
  const before = await savedRoadmap(at.roadmap);
  if (before === undefined) return;
  const shipped = setLaneStatus(before, version, 'shipped');
  if (!shipped.ok) return refuse(shipped.error);
  const roadmapPath = at.roadmap;
  const drafted = await progress(`preparing ${version}…`, () =>
    draftRelease({ repoRoot: at.repoRoot, base: at.base, version, versionFiles: state.settings.releaseVersionFiles, roadmap: shipped.text, date: today() }),
  );
  if (!drafted.ok) return refuse(drafted.error);
  const { draft } = drafted;
  const title = releaseTitle(version);
  const body = releaseBody(lane, draft.notes);
  const local = state.work.items.find((i) => i.isDefault)?.ahead ?? 0;
  const go = 'Open release PR';
  const detail = [
    `Opens a pull request into ${at.base} from a new branch ${branch}, made from ${REMOTE}/${at.base} (${draft.baseSha.slice(0, 7)}) in a temporary worktree. This checkout is not touched.`,
    draft.files.map((f) => `${f.path}: ${f.change}`).join('\n'),
    local ? `${plural(local, 'commit')} on your local ${at.base} ${local === 1 ? 'is' : 'are'} not on ${REMOTE}, and not part of this release.` : '',
    `Title: ${title}`,
    `Body:\n${preview(body)}`,
    `Once it merges, the lane offers to tag ${tagName(version)}.`,
  ]
    .filter(Boolean)
    .join('\n\n');
  if ((await vscode.window.showWarningMessage(`Release ${version}?`, { modal: true, detail }, go)) !== go) return;
  if ((await roadmapNow(roadmapPath)) !== before) return refuse('ROADMAP.md changed while the confirmation was open. Release again to see it as it is now.');
  const outcome = await progress(`opening the ${version} pull request…`, () => openRelease(draft, title, body, runGh));
  await host.refresh();
  await tell(`Release ${version}`, outcome);
}

/** Tags the commit the release pull request merged as, and pushes the tag: only after a confirmation that says a
 *  tag may deploy. */
async function tag(version: string, host: ActionHost): Promise<void> {
  const state = host.state();
  if (!state) return;
  const at = mainCheckout(state);
  if (typeof at === 'string') return refuse(at);
  const lane = state.releases.roadmap.find((l) => !l.backlog && l.version === version);
  if (!lane || releaseStep(lane, state)?.step !== 'tag') return refuse(`${version} is not merged yet, or is tagged already.`);
  const problem = await publishProblem(state, at.repoRoot);
  if (problem) return refuse(problem);
  const found = await progress(`finding the ${version} merge…`, () => findRelease(runGh, at.repoRoot, at.base, version));
  if (!found.ok) return refuse(found.error);
  const name = tagName(version);
  const go = `Tag and push ${name}`;
  const detail = `Tags ${found.sha.slice(0, 7)}, the merge of the release pull request #${found.pr} into ${at.base}, as ${name} (an annotated tag, "${releaseTitle(version)}"), and pushes the tag to ${REMOTE}.\n\nA pushed tag may deploy: release workflows often start on a new tag. Cockpit never tags on its own.`;
  if ((await vscode.window.showWarningMessage(`Tag ${name} and push it?`, { modal: true, detail }, go)) !== go) return;
  const outcome = await progress(`tagging ${name}…`, () => pushTag(at.repoRoot, version, found.sha));
  await host.refresh();
  await tell(`Tag ${name}`, outcome);
}

/** Brings the main checkout up to date after a merge: ROADMAP.md first reads as the merge has it, so the autostash
 *  puts back only the board's edits made since. */
async function pull(host: ActionHost): Promise<void> {
  const state = host.state();
  if (!state) return;
  const at = mainCheckout(state);
  if (typeof at === 'string') return refuse(at);
  if (!state.work.items.some((i) => i.isDefault && i.worktreePath === at.repoRoot)) return refuse(`The main checkout is not on ${at.base}: switch to it to pull.`);
  await syncMerged(host);
  const outcome = await progress(`pulling ${at.base}…`, () => pullDefault(at.repoRoot));
  await host.refreshLocal();
  if (outcome.ok) vscode.window.setStatusBarMessage(`Cockpit: ${at.base} ${outcome.done.join(', ')}`, 4000);
  else await tell(`Pull ${at.base}`, outcome);
}

let syncing: Promise<void> | undefined;

/** Makes the main checkout's ROADMAP.md read as what merged: the cards of a branch whose pull request merged are done
 *  and unlinked, and a release whose pull request merged is shipped. That is the text the merge put on the default
 *  branch, so the pull after it leaves ROADMAP.md clean. Called on every new State; it rarely has anything to do,
 *  and waits while ROADMAP.md has unsaved edits in an editor. */
export function syncMerged(host: ActionHost): Promise<void> {
  if (syncing) return syncing;
  const state = host.state();
  const at = state && mainCheckout(state);
  if (!state || !at || typeof at === 'string' || !at.roadmap) return Promise.resolve();
  const { branches, versions } = mergedWork(state);
  if (branches.length === 0 && versions.length === 0) return Promise.resolve();
  const path = at.roadmap;
  syncing = inRoadmapQueue(async () => {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    if (doc.isDirty) return;
    const changed = await changeRoadmap(
      path,
      (text) => {
        let out = text;
        for (const b of branches) out = finishBranch(out, b);
        for (const v of versions) {
          const r = setLaneStatus(out, v, 'shipped');
          if (r.ok) out = r.text;
        }
        return { ok: true, text: out };
      },
      host,
    );
    if (changed) vscode.window.setStatusBarMessage('Cockpit: ROADMAP.md now reads as what merged', 4000);
  }).finally(() => {
    syncing = undefined;
  });
  return syncing;
}

function refuse(message: string): void {
  void vscode.window.showWarningMessage(message);
}

function focus(session: ClaudeSession, host: ActionHost): void {
  const terminal = host.terminalFor(session.sessionId);
  if (!terminal) return refuse('This Claude is not running in a terminal of this window.');
  terminal.show(false);
}

function resume(session: ClaudeSession, host: ActionHost): void {
  if (session.live) {
    if (host.terminalFor(session.sessionId)) return focus(session, host);
    return refuse(`"${session.title}" is running in another terminal${session.pid ? ` (pid ${session.pid})` : ''}. Resuming it twice would make two Claudes write the same session.`);
  }
  if (!isSessionId(session.sessionId)) return refuse('That session id looks wrong; not resuming it.');
  if (!session.cwd || !existsSync(session.cwd)) {
    return refuse(`The folder this session ran in${session.cwd ? ` (${session.cwd})` : ''} is gone, and Claude Code finds sessions by folder.`);
  }
  const terminal = vscode.window.createTerminal({ name: `Claude: ${session.title.slice(0, 40)}`, cwd: session.cwd, iconPath: new vscode.ThemeIcon('sparkle') });
  terminal.show(false);
  // The id was checked above, so this line has nothing for the shell to interpret.
  terminal.sendText(`claude --resume ${session.sessionId}`, true);
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
  if (i.worktreePath && i.sessionIds.length) parts.push(`${i.sessionIds.length} ended Claude session${i.sessionIds.length === 1 ? '' : 's'} ran there`);
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
    const nothing = 'Nothing to clean: no merged branch is clean, unused and free of live Claudes.';
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
