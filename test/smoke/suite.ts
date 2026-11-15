// Runs inside the VS Code that run.mjs starts. The extension's activate() returns a small test API.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';
import type { CockpitTestApi } from '../../src/extension';
import type { RoadmapEdit } from '../../src/model';

async function waitFor(what: string, check: () => boolean, timeoutMs = 30_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting until ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const cockpitTabs = () =>
  vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith('cockpit.overview'));

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension<CockpitTestApi>('rrayes.cockpit');
  assert.ok(ext, 'the extension is installed in the test instance');
  const api = await ext.activate();

  // Startup takeover: cockpit.openOnStartup is on by default.
  await waitFor('Cockpit opened on its own at startup', () => api.panelOpen());

  // A file the person opens goes beside Cockpit; opening Cockpit again reveals the same tab.
  const workspace = process.env.COCKPIT_SMOKE_WORKSPACE ?? '';
  await vscode.window.showTextDocument(vscode.Uri.file(`${workspace}/CHANGELOG.md`), { preview: false });
  await vscode.commands.executeCommand('cockpit.open');
  await vscode.commands.executeCommand('cockpit.open');
  // Tab state reaches the extension host through an event, a moment after the reveal.
  await waitFor('cockpit.open revealed the tab', () => cockpitTabs()[0]?.isActive === true, 5000);
  const tabs = cockpitTabs();
  assert.equal(tabs.length, 1, 'exactly one Cockpit tab');
  const tab = tabs[0] as vscode.Tab;
  assert.ok(tab.isPinned, 'the Cockpit tab is pinned');
  assert.equal(tab.group.viewColumn, vscode.ViewColumn.One);
  assert.equal(tab.group.tabs[0], tab, 'Cockpit is the first tab');
  assert.ok(
    tab.group.tabs.some((t) => t.input instanceof vscode.TabInputText && t.input.uri.fsPath.endsWith('CHANGELOG.md')),
    'the file opened before stays open',
  );

  // The data layer produced a State from the workspace and the fixture Claude directory.
  await vscode.commands.executeCommand('cockpit.refresh');
  await waitFor('a State with git data', () => api.state()?.work.available === true);
  const state = api.state();
  assert.ok(state);
  assert.equal(state.workspace?.name, 'shop');
  assert.equal(state.work.defaultBranch, 'main');
  const groups = Object.fromEntries(state.work.items.map((i) => [i.branch, i.group]));
  assert.deepEqual(groups, { main: 'active', wip: 'active', 'merged-feature': 'merged', feature: 'active' });
  assert.equal(state.releases.currentVersion, '0.3.0');
  assert.equal(state.releases.changelog[0]?.version, 'Unreleased');
  assert.ok(Object.keys(state.sessions).length > 0, 'sessions read from CLAUDE_CONFIG_DIR');
  assert.equal(state.projects[0]?.isWorkspace, true, 'the workspace project comes first');

  // The roadmap board: every edit goes through the same handler as a webview message, and lands in ROADMAP.md.
  const roadmapFile = state.releases.roadmapPath ?? '';
  const onDisk = () => readFileSync(roadmapFile, 'utf8');
  const lanes = () => api.state()?.releases.roadmap ?? [];
  const card = (text: string) => lanes().flatMap((l) => l.items).find((i) => i.text === text);
  const edit = (e: RoadmapEdit) => api.receive({ type: 'roadmap', edit: e });
  assert.ok(roadmapFile.endsWith('/shop/ROADMAP.md'), 'the roadmap lives at the top of the worktree');
  assert.equal(state.releases.roadmapExists, false);
  assert.ok(!existsSync(roadmapFile));

  await edit({ op: 'create' });
  assert.equal(onDisk(), '# Roadmap\n\n## 0.4.0\n\n## Backlog\n', 'the starter plans the next minor version');
  assert.deepEqual(lanes().map((l) => l.version), ['0.4.0', 'Backlog']);

  await edit({ op: 'add', lane: '0.4.0', text: 'Gift cards' });
  await edit({ op: 'add', lane: '0.4.0', text: 'Wish lists' });
  assert.equal(onDisk(), '# Roadmap\n\n## 0.4.0\n\n- [ ] Gift cards\n- [ ] Wish lists\n\n## Backlog\n');
  assert.equal(card('Gift cards')?.status, 'todo', 'the board shows the new card without waiting for a refresh');

  await edit({ op: 'setStatus', id: card('Wish lists')?.id ?? '', status: 'doing' });
  await edit({ op: 'setText', id: card('Gift cards')?.id ?? '', text: 'Gift cards at checkout' });
  const beforeMove = onDisk();
  assert.equal(beforeMove, '# Roadmap\n\n## 0.4.0\n\n- [ ] Gift cards at checkout\n- [~] Wish lists\n\n## Backlog\n');

  await edit({ op: 'move', id: card('Gift cards at checkout')?.id ?? '', lane: 'Backlog', status: 'done' });
  const afterMove = onDisk();
  assert.equal(afterMove, '# Roadmap\n\n## 0.4.0\n\n- [~] Wish lists\n\n## Backlog\n\n- [x] Gift cards at checkout\n');
  assert.equal(lanes()[1]?.items[0]?.status, 'done');

  await edit({ op: 'addRelease', version: '0.5.0', title: 'Loyalty' });
  assert.match(onDisk(), /- \[~\] Wish lists\n\n## 0\.5\.0 — Loyalty\n\n## Backlog\n/);

  // An id from before the file changed is refused, and nothing is written.
  const current = onDisk();
  await edit({ op: 'setStatus', id: '5:nosuchline', status: 'done' });
  assert.equal(onDisk(), current, 'a stale edit changes nothing');

  // The edits are ordinary editor edits: undo in ROADMAP.md takes the last one back.
  const editor = await vscode.window.showTextDocument(vscode.Uri.file(roadmapFile), { preview: false });
  await vscode.commands.executeCommand('undo');
  assert.equal(editor.document.getText(), afterMove, 'undo takes back the last board edit');
  await vscode.commands.executeCommand('workbench.action.files.save');
  // Cockpit was hidden behind the editor; it catches up when it is shown again.
  await vscode.commands.executeCommand('cockpit.open');
  await waitFor('the board follows a change made in the editor', () => lanes().length === 2, 10_000);

  await publishing(api, workspace);

  // Maximize runs VS Code's own layout commands, which must exist in this VS Code, and changes no setting.
  const commands = await vscode.commands.getCommands(true);
  for (const c of ['workbench.action.maximizeEditorHideSidebar', 'workbench.action.closePanel']) assert.ok(commands.includes(c), `VS Code has ${c}`);
  await vscode.commands.executeCommand('workbench.view.extension.cockpit');
  await api.receive({ type: 'maximize' });
  await waitFor('Maximize brought Cockpit to the front', () => cockpitTabs()[0]?.isActive === true, 5000);
  assert.equal(vscode.workspace.getConfiguration('zenMode').inspect('fullScreen')?.defaultValue, true, 'Zen mode keeps its own defaults');

  // The webview script ran under the Content-Security-Policy (it posted "ready") and received the State.
  await waitFor('the webview loaded and got a State', () => api.webviewReady() && api.statesPosted() > 0);
  console.log(
    `smoke: panel open, ${Object.keys(state.sessions).length} sessions, ${state.work.items.length} work items, ` +
      `${api.statesPosted()} States posted, GitHub: ${state.work.github ?? state.work.githubNote ?? 'not asked yet'}`,
  );
}


const git = (dir: string, ...args: string[]): string => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();

interface Shown {
  message: string;
  detail?: string;
  modal: boolean;
  items: string[];
}

/** Ship, Release, Tag, Pull and Catch up, through the same handler as the webview's messages, against the local origin
 *  and the stand-in gh that run.mjs set up. Every confirmation is answered "cancel": what each would send is checked in
 *  its dialog, and nothing reaches origin. */
async function publishing(api: CockpitTestApi, workspace: string): Promise<void> {
  const ghDir = process.env.COCKPIT_SMOKE_GH ?? '';
  const ghCalls = () => (existsSync(join(ghDir, 'calls.log')) ? readFileSync(join(ghDir, 'calls.log'), 'utf8').split('\n').filter(Boolean) : []);
  assert.ok(ghCalls().some((c) => c.startsWith('repo view')), 'Cockpit asked the stand-in gh, first on the PATH');

  // The extension shares this vscode module: its warnings and errors come here instead, and every dialog is cancelled.
  const shown: Shown[] = [];
  const record = (message: string, ...rest: unknown[]): Promise<undefined> => {
    const options = typeof rest[0] === 'object' && rest[0] !== null ? (rest.shift() as vscode.MessageOptions) : undefined;
    shown.push({ message, ...(options?.detail ? { detail: options.detail } : {}), modal: options?.modal === true, items: rest.map(String) });
    return Promise.resolve(undefined);
  };
  const window = vscode.window as { showWarningMessage: unknown; showErrorMessage: unknown };
  const original = { warning: window.showWarningMessage, error: window.showErrorMessage };
  window.showWarningMessage = record;
  window.showErrorMessage = record;
  const last = (): Shown => {
    const s = shown.at(-1);
    assert.ok(s, 'a message was shown');
    return s;
  };
  // The path as Cockpit has it (git's, with symbolic links resolved): the same document the extension opens.
  const roadmapFile = api.state()?.releases.roadmapPath ?? '';
  const feature = join(dirname(workspace), 'shop-feature');
  const onOrigin = (ref: string) => git(workspace, 'ls-remote', 'origin', ref);
  try {
    // Without GitHub, Ship says why instead of asking.
    await api.receive({ type: 'ship', branch: 'feature' });
    assert.equal(last().modal, false);
    assert.match(last().message, /^GitHub is not available here \(no GitHub remote\): Cockpit publishes through gh\.$/);

    // The stand-in gh now knows the repository, and the release-0.4.0 pull request merged as origin's main.
    writeFileSync(join(ghDir, 'merge-sha'), git(workspace, 'rev-parse', 'origin/main'));
    writeFileSync(join(ghDir, 'online'), '');
    await api.receive({ type: 'refresh' });
    await waitFor('GitHub is available', () => api.state()?.work.github === 'smoke/shop');

    // Ship: the dialog shows where the branch goes and the pull request it opens; cancelled, nothing is pushed.
    const featureHead = git(feature, 'rev-parse', 'HEAD');
    shown.length = 0;
    await api.receive({ type: 'ship', branch: 'feature' });
    assert.equal(last().message, 'Ship feature?', JSON.stringify(shown));
    assert.ok(last().modal);
    assert.deepEqual(last().items, ['Push and open PR']);
    assert.match(last().detail ?? '', /^Pushes feature to origin and opens a pull request into main\./);
    assert.match(last().detail ?? '', /\nTitle: Add the feature\n/);
    assert.equal(onOrigin('refs/heads/feature'), '', 'feature is not on origin');
    assert.equal(git(feature, 'rev-parse', 'HEAD'), featureHead, 'nothing was committed on feature');

    // A board with a shipped 0.4.0, to tag, and a 0.5.0 whose cards are done, to release.
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(roadmapFile));
    const board = new vscode.WorkspaceEdit();
    board.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), '# Roadmap\n\n## 0.4.0\n\nStatus: shipped\n\n- [x] Gift cards\n\n## 0.5.0 — Loyalty\n\n- [x] Points\n\n## Backlog\n');
    assert.ok(await vscode.workspace.applyEdit(board));
    assert.ok(await doc.save());
    const lane = (v: string) => api.state()?.releases.roadmap.find((l) => l.version === v);
    await waitFor('the board has the releases', () => lane('0.4.0')?.status === 'shipped' && lane('0.5.0')?.items[0]?.status === 'done', 10_000);

    // Release: the dialog lists the version bump and the pull request; cancelled, no branch is left anywhere.
    shown.length = 0;
    await api.receive({ type: 'release', version: '0.5.0' });
    assert.equal(last().message, 'Release 0.5.0?', JSON.stringify(shown));
    assert.ok(last().modal);
    assert.deepEqual(last().items, ['Open release PR']);
    assert.match(last().detail ?? '', /new branch release-0\.5\.0, made from origin\/main/);
    assert.match(last().detail ?? '', /package\.json: 0\.3\.0 → 0\.5\.0/);
    assert.match(last().detail ?? '', /\nTitle: Release 0\.5\.0\n/);
    assert.equal(onOrigin('refs/heads/release-0.5.0'), '', 'release-0.5.0 is not on origin');
    assert.equal(git(workspace, 'branch', '--list', 'release-0.5.0'), '', 'no local release-0.5.0 either');
    assert.equal(git(workspace, 'worktree', 'list').split('\n').length, 2, 'no temporary worktree is left');

    // Tag: the dialog names the merge commit and warns that a tag may deploy; cancelled, no tag anywhere.
    shown.length = 0;
    await api.receive({ type: 'tag', version: '0.4.0' });
    assert.equal(last().message, 'Tag v0.4.0 and push it?', JSON.stringify(shown));
    assert.ok(last().modal);
    assert.deepEqual(last().items, ['Tag and push v0.4.0']);
    assert.match(last().detail ?? '', /the merge of the release pull request #7 into main, as v0\.4\.0/);
    assert.match(last().detail ?? '', /A pushed tag may deploy/);
    assert.equal(git(workspace, 'tag', '--list'), '', 'no local tag');
    assert.equal(git(workspace, 'ls-remote', '--tags', 'origin'), '', 'no tag on origin');

    // Pull: a commit that reached origin's main from elsewhere comes into the main checkout.
    const elsewhere = join(dirname(workspace), 'elsewhere');
    execFileSync('git', ['clone', '-q', join(dirname(workspace), 'origin.git'), elsewhere]);
    git(elsewhere, '-c', 'user.email=smoke@example.com', '-c', 'user.name=Smoke', 'commit', '-q', '--allow-empty', '-m', 'Merged elsewhere');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    shown.length = 0;
    await api.receive({ type: 'pullDefault' });
    assert.deepEqual(shown, [], 'Pull showed no warning or error');
    assert.equal(git(workspace, 'rev-parse', 'main'), git(elsewhere, 'rev-parse', 'HEAD'), 'main has the commit from origin');

    // Catch up: closing it stores the mark it is counted from.
    const before = Date.now();
    await api.receive({ type: 'caughtUp' });
    await waitFor('the catch-up mark is stored', () => (api.state()?.caughtUp?.at ?? 0) >= before, 5000);

    // gh was only asked to read: nothing was created on GitHub.
    const writes = ghCalls().filter((c) => !/^(repo view|pr list|run list) /.test(c));
    assert.deepEqual(writes, [], 'gh was only asked to read');
  } finally {
    window.showWarningMessage = original.warning;
    window.showErrorMessage = original.error;
  }
}
