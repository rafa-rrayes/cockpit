// Every message the webview can post, handled here. The webview is treated as untrusted input: each message is
// checked against the current State (known session ids, known paths, links it shows) before anything happens, and
// nothing changes on disk except through cleanMerged, which lists what it would do and asks first, and through the
// roadmap board, which edits ROADMAP.md and nothing else.
import { existsSync, statSync } from 'node:fs';
import * as vscode from 'vscode';
import { removeMerged } from './clean';
import { applyRoadmapEdit, parseRoadmap, starterRoadmap } from './data/roadmap';
import { cleanCandidates, isSessionId, knownFolders, knownUrls, parseMessage } from './guards';
import type { ClaudeSession, RoadmapEdit, State, WorkItem } from './model';

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
    case 'roadmap': {
      // One edit at a time: each reads the file the one before it wrote.
      const run = roadmapQueue.then(() => editRoadmap(msg.edit, host));
      roadmapQueue = run.catch(() => undefined);
      return run;
    }
    case 'openRoadmap': {
      const path = state?.releases.roadmapPath;
      if (!path || !existsSync(path)) return refuse('There is no ROADMAP.md yet.');
      await vscode.window.showTextDocument(vscode.Uri.file(path), { preview: false, viewColumn: vscode.ViewColumn.Beside });
      return;
    }
  }
}

let roadmapQueue: Promise<void> = Promise.resolve();

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

  // Through the document, not the file: a ROADMAP.md open in an editor is edited as it stands there, and the
  // change can be undone there.
  const doc = await vscode.workspace.openTextDocument(uri);
  if (edit.op === 'remove') {
    const item = parseRoadmap(doc.getText())
      .flatMap((lane) => lane.items)
      .find((i) => i.id === edit.id);
    const answer = item && (await vscode.window.showWarningMessage(`Delete "${item.text}" from the roadmap?`, { modal: true }, 'Delete'));
    if (item && answer !== 'Delete') return;
  }
  const before = doc.getText();
  const result = applyRoadmapEdit(before, edit);
  if (!result.ok) {
    refuse(result.error);
    host.roadmapChanged(before);
    return;
  }
  const after = result.text;
  // Only the span that differs, so an editor showing the file keeps its cursor and scroll position.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const change = new vscode.WorkspaceEdit();
  change.replace(uri, new vscode.Range(doc.positionAt(start), doc.positionAt(endBefore)), after.slice(start, endAfter));
  if (!(await vscode.workspace.applyEdit(change)) || !(await doc.save())) {
    refuse('Could not write ROADMAP.md.');
    return host.refreshGit();
  }
  host.roadmapChanged(doc.getText());
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
