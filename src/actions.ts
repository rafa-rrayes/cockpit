// Every message the webview can post, handled here. The webview is treated as untrusted input: each message is
// checked against the current State (known session ids, known paths, https URLs) before anything happens, and
// nothing changes on disk except through cleanMerged, which lists what it would do and asks first.
import { existsSync, statSync } from 'node:fs';
import * as vscode from 'vscode';
import { runGit } from './data/git';
import { cleanCandidates, isHttpsUrl, isSessionId, knownFolders, parseMessage } from './guards';
import type { ClaudeSession, State, WorkItem } from './model';

export interface ActionHost {
  state(): State | undefined;
  refresh(): Promise<void>;
  refreshGit(): Promise<void>;
  terminalFor(sessionId: string): vscode.Terminal | undefined;
  /** Sends the current State to the webview again. */
  resend(): void;
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
      if (!isHttpsUrl(msg.url)) return refuse(`Cockpit only opens https links.`);
      await vscode.env.openExternal(vscode.Uri.parse(msg.url, true));
      return;
    case 'openFolder':
      if (!state || !knownFolders(state).has(msg.path)) return refuse('Cockpit only opens folders it shows.');
      if (!existsSync(msg.path)) return refuse(`${msg.path} no longer exists.`);
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.path), { forceNewWindow: msg.newWindow });
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
  }
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

async function cleanMerged(host: ActionHost): Promise<void> {
  // Decide on fresh data, not on a State that may be a minute old.
  await host.refreshGit();
  const state = host.state();
  const repoRoot = state?.work.repoRoot;
  if (!state || !repoRoot) return refuse('No git repository is open.');
  const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  const items = cleanCandidates(state, folders);
  if (items.length === 0) {
    void vscode.window.showInformationMessage('Nothing to clean: no merged branch is clean, unused and free of live Claudes.');
    return;
  }
  const worktrees = items.filter((i) => i.worktreePath).length;
  const detail = [
    `Removes ${worktrees} worktree${worktrees === 1 ? '' : 's'} with "git worktree remove" and deletes ${items.length} branch${items.length === 1 ? '' : 'es'} with "git branch -d". Git refuses anything with uncommitted changes or unmerged commits, and those are kept.`,
    '',
    ...items.map(describe),
  ].join('\n');
  const go = `Remove ${items.length}`;
  const answer = await vscode.window.showWarningMessage(`Clean ${items.length} merged branch${items.length === 1 ? '' : 'es'}?`, { modal: true, detail }, go);
  if (answer !== go) return;

  const removed: string[] = [];
  const refused: string[] = [];
  const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';
  for (const item of items) {
    if (item.worktreePath) {
      const r = await runGit(repoRoot, ['worktree', 'remove', item.worktreePath], 30_000);
      if (!r.ok) {
        refused.push(`${item.branch}: ${firstLine(r.stderr) || 'git worktree remove failed'}`);
        continue;
      }
    }
    const r = await runGit(repoRoot, ['branch', '-d', item.branch], 15_000);
    if (r.ok) removed.push(item.worktreePath ? `${item.branch} and its worktree` : item.branch);
    else refused.push(`${item.branch}: ${firstLine(r.stderr) || 'git branch -d failed'}${item.worktreePath ? ' (its worktree was removed)' : ''}`);
  }
  await host.refreshGit();

  const lines = [
    removed.length ? `Removed:\n${removed.join('\n')}` : 'Nothing was removed.',
    refused.length ? `Git refused:\n${refused.join('\n')}` : '',
  ].filter(Boolean);
  const summary = `Cleaned ${removed.length} of ${items.length}.`;
  void vscode.window.showInformationMessage(summary, { modal: true, detail: lines.join('\n\n') });
}
