// Activation: one Cockpit tab in the editor area (created, revealed, or restored after a reload), the startup
// takeover, the status-bar item and the activity-bar entry. Data comes from the Store; actions go to actions.ts.
import { randomBytes } from 'node:crypto';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { type ActionHost, handleMessage } from './actions';
import type { HostMessage, State } from './model';
import { defaultClaudeDir } from './sources';
import { Store } from './store';
import { WindowRegistry } from './windows';

const VIEW_TYPE = 'cockpit.overview';
const ASKED_STARTUP_EDITOR = 'cockpit.askedStartupEditor';
/** How long opening waits for VS Code to restore the Cockpit tab it showed before a reload. */
const RESTORE_WAIT_MS = 3000;

/** What the smoke test reads; not used by the extension itself. */
export interface CockpitTestApi {
  state(): State | undefined;
  panelOpen(): boolean;
  webviewReady(): boolean;
  statesPosted(): number;
  /** Handles `message` as if the webview had posted it. */
  receive(message: unknown): Promise<void>;
}

function cockpitTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((g) =>
    // Extension webviews show up with their view type prefixed ("mainThreadWebview-cockpit.overview").
    g.tabs.filter((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(VIEW_TYPE)),
  );
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', file)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${asset('webview.css')}">
<title>Cockpit</title>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${asset('webview.js')}"></script>
</body>
</html>`;
}

class CockpitPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private ready = false;
  private posted = 0;
  private opening: Promise<void> | undefined;
  /** Pending while VS Code is expected to hand back a restored tab through the serializer. */
  private restoring: Promise<void> | undefined;
  private restored: (() => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly store: Store,
    private readonly windows: WindowRegistry,
  ) {
    this.disposables.push(
      store.onDidChange(() => this.post()),
    );
    // A Cockpit tab that is visible after a reload is revived right after activation: wait for it instead of
    // opening a second one. A restored tab in the background is only revived when shown, so it is replaced.
    if (cockpitTabs().some((t) => t.isActive)) {
      this.restoring = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, RESTORE_WAIT_MS);
        this.restored = () => {
          clearTimeout(timer);
          resolve();
        };
      }).then(() => {
        this.restoring = undefined;
      });
    }
  }

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  get isReady(): boolean {
    return this.ready;
  }

  get postedCount(): number {
    return this.posted;
  }

  /** Reveals the tab, creating it (in the first column, pinned) when there is none. Calls overlap safely. */
  open(): Promise<void> {
    this.opening ??= this.openOnce().finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }

  private async openOnce(): Promise<void> {
    if (this.restoring) await this.restoring;
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.One);
      return;
    }
    const stale = cockpitTabs();
    if (stale.length) await vscode.window.tabGroups.close(stale, true);
    if (this.panel) return;
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Cockpit', { viewColumn: vscode.ViewColumn.One, preserveFocus: false }, this.options());
    this.adopt(panel);
    // Pinned tabs sit first in the group and survive "close all"; the new panel is the active editor here.
    await vscode.commands.executeCommand('workbench.action.pinEditor');
  }

  /** The serializer's half: VS Code hands back the tab it restored after a reload. */
  restore(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      // A second tab would mean two Cockpits; keep the one already running.
      panel.dispose();
      return;
    }
    panel.webview.options = this.options();
    this.adopt(panel);
    this.restored?.();
  }

  private options(): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    return {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
  }

  private adopt(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.ready = false;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, 'media', 'cockpit-light.svg'),
      dark: vscode.Uri.joinPath(this.extensionUri, 'media', 'cockpit-dark.svg'),
    };
    panel.webview.html = html(panel.webview, this.extensionUri);
    const subs: vscode.Disposable[] = [
      panel.webview.onDidReceiveMessage((raw: unknown) =>
        this.receive(raw).catch((e: unknown) => void vscode.window.showErrorMessage(`Cockpit: ${e instanceof Error ? e.message : String(e)}`)),
      ),
      panel.onDidChangeViewState((e) => this.store.setVisible(e.webviewPanel.visible)),
    ];
    panel.onDidDispose(() => {
      for (const s of subs) s.dispose();
      if (this.panel !== panel) return;
      this.panel = undefined;
      this.ready = false;
      this.store.setVisible(false);
    });
    this.store.setVisible(panel.visible);
  }

  /** What actions.ts acts through. */
  private readonly host: ActionHost = {
    state: () => this.store.state,
    refresh: () => this.store.refresh(),
    refreshLocal: () => this.store.refreshLocal(),
    refreshGit: () => this.store.refreshGit(),
    otherWindowFolders: () => this.windows.otherFolders(),
    terminalFor: (id) => this.store.terminalFor(id),
    roadmapChanged: (text) => this.store.setRoadmap(text),
    caughtUp: (mark) => this.store.setCaughtUp(mark),
    resend: () => {
      this.ready = true;
      this.post();
    },
  };

  /** A message from the webview (the smoke test sends them through here too). */
  receive(raw: unknown): Promise<void> {
    return handleMessage(raw, this.host);
  }

  private post(): void {
    const state = this.store.state;
    if (!this.panel || !this.ready || !state) return;
    const message: HostMessage = { type: 'state', state };
    void this.panel.webview.postMessage(message).then((ok) => {
      if (ok) this.posted++;
    });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.panel?.dispose();
  }
}

/** The status-bar item and the activity-bar badge: how many things need the person. */
function attentionIndicators(store: Store, view: vscode.TreeView<never>): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('cockpit.status', vscode.StatusBarAlignment.Left, 100);
  item.name = 'Cockpit';
  item.command = 'cockpit.open';
  const update = (state: State | undefined) => {
    const attention = state?.attention ?? [];
    const live = state ? Object.values(state.sessions).filter((s) => s.live).length : 0;
    item.text = attention.length ? `$(dashboard) Cockpit $(bell-dot) ${attention.length}` : '$(dashboard) Cockpit';
    item.backgroundColor = attention.length ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    item.tooltip = [
      `Cockpit: ${live} live Claude${live === 1 ? '' : 's'}`,
      ...attention.map((a) => `• ${a.title}${a.detail ? ` (${a.detail})` : ''}`),
      'Click to open',
    ].join('\n');
    view.badge = attention.length ? { value: attention.length, tooltip: `${attention.length} need${attention.length === 1 ? 's' : ''} you` } : undefined;
  };
  update(store.state);
  item.show();
  return vscode.Disposable.from(item, store.onDidChange(update));
}

/** Offers, once, to stop the Welcome page from opening next to Cockpit. */
async function offerQuietStartup(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(ASKED_STARTUP_EDITOR)) return;
  const workbench = vscode.workspace.getConfiguration('workbench');
  if (workbench.get<string>('startupEditor') === 'none') return;
  const turnOff = 'Turn off Welcome';
  const answer = await vscode.window.showInformationMessage(
    'Cockpit opens when a window starts. Stop the Welcome page from opening too? (sets workbench.startupEditor to "none")',
    turnOff,
    'Keep it',
  );
  if (answer === undefined) return; // dismissed: ask again next time
  await context.globalState.update(ASKED_STARTUP_EDITOR, true);
  if (answer === turnOff) await workbench.update('startupEditor', 'none', vscode.ConfigurationTarget.Global);
}

export function activate(context: vscode.ExtensionContext): CockpitTestApi {
  const log = vscode.window.createOutputChannel('Cockpit', { log: true });
  const folder = vscode.workspace.workspaceFolders?.[0];
  const store = new Store({
    workspace: folder ? { name: folder.name || basename(folder.uri.fsPath), path: folder.uri.fsPath } : undefined,
    claudeDir: defaultClaudeDir(),
    log: (line) => log.warn(line),
    memory: context.workspaceState,
  });
  // Every window records its folders, so "Clean merged" in one never removes a worktree another one shows.
  const windows = new WindowRegistry(join(context.globalStorageUri.fsPath, 'windows'));
  const publishFolders = () => windows.publish((vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath));
  publishFolders();
  const panel = new CockpitPanel(context.extensionUri, store, windows);

  // The activity-bar entry: its view holds a welcome text with an Open button, and showing it opens the tab.
  const view = vscode.window.createTreeView<never>('cockpit.home', { treeDataProvider: { getChildren: () => [], getTreeItem: (e) => e } });

  context.subscriptions.push(
    log,
    windows,
    vscode.workspace.onDidChangeWorkspaceFolders(publishFolders),
    store,
    panel,
    view,
    view.onDidChangeVisibility((e) => {
      if (e.visible) void panel.open();
    }),
    attentionIndicators(store, view),
    vscode.commands.registerCommand('cockpit.open', () => panel.open()),
    vscode.commands.registerCommand('cockpit.refresh', () => store.refresh()),
    // Maximizing is Zen mode with the Cockpit tab in front: VS Code restores the side bars and the panel exactly as
    // they were, which an extension cannot (it can close them but not read whether they were open). The keybinding
    // only calls this outside Zen mode; inside it the same keys run workbench.action.exitZenMode.
    vscode.commands.registerCommand('cockpit.maximize', async () => {
      await panel.open();
      await vscode.commands.executeCommand('workbench.action.toggleZenMode');
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (restored) => panel.restore(restored),
    }),
  );

  if (vscode.workspace.getConfiguration('cockpit').get<boolean>('openOnStartup', true)) {
    void panel.open().then(() => offerQuietStartup(context));
  }

  return {
    state: () => store.state,
    panelOpen: () => panel.isOpen,
    webviewReady: () => panel.isReady,
    statesPosted: () => panel.postedCount,
    receive: (message) => panel.receive(message),
  };
}
