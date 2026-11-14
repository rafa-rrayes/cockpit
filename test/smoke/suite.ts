// Runs inside the VS Code that run.mjs starts. The extension's activate() returns a small test API.
import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
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
  assert.deepEqual(groups, { main: 'active', wip: 'active', 'merged-feature': 'merged' });
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

  // The webview script ran under the Content-Security-Policy (it posted "ready") and received the State.
  await waitFor('the webview loaded and got a State', () => api.webviewReady() && api.statesPosted() > 0);
  console.log(
    `smoke: panel open, ${Object.keys(state.sessions).length} sessions, ${state.work.items.length} work items, ` +
      `${api.statesPosted()} States posted, GitHub: ${state.work.github ?? state.work.githubNote ?? 'not asked yet'}`,
  );
}

