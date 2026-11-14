// Runs inside the VS Code that run.mjs starts. The extension's activate() returns a small test API.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { CockpitTestApi } from '../../src/extension';

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

  // The webview script ran under the Content-Security-Policy (it posted "ready") and received the State.
  await waitFor('the webview loaded and got a State', () => api.webviewReady() && api.statesPosted() > 0);
  console.log(
    `smoke: panel open, ${Object.keys(state.sessions).length} sessions, ${state.work.items.length} work items, ` +
      `${api.statesPosted()} States posted, GitHub: ${state.work.github ?? state.work.githubNote ?? 'not asked yet'}`,
  );
}

