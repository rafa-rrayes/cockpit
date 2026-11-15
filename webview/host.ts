// The one place that talks to the extension host. Inside VS Code it wraps acquireVsCodeApi(); in a plain browser
// (dev.html) it plays the host itself: actions go to an on-screen log and State comes from
// window.__COCKPIT_DEV_STATE__, so the UI runs unchanged in both.
import { markOf } from '../src/catchup';
import { applyRoadmapEdit, parseRoadmap, starterRoadmap } from '../src/data/roadmap';
import type { HostMessage, RoadmapEdit, State, WebviewMessage } from '../src/model';
import { type SettingEdit, readSettings, storedValue } from '../src/settings';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    __COCKPIT_DEV_STATE__?: State;
    /** Dev only: the ROADMAP.md the preview edits. */
    __COCKPIT_DEV_ROADMAP__?: string;
  }
}

// VS Code defines this in the webview's global scope (not always as a window property), so it is read through
// `typeof` on the bare name.
declare const acquireVsCodeApi: (() => VsCodeApi) | undefined;

export interface DevLogEntry {
  at: number;
  message: WebviewMessage;
}

export interface Host {
  /** True in a plain browser: there is no extension host behind the page. */
  readonly isDev: boolean;
  post(message: WebviewMessage): void;
  onState(listener: (state: State) => void): () => void;
  getUiState(): unknown;
  setUiState(state: unknown): void;
  /** Dev only: the messages the page has posted, newest last. */
  onDevLog(listener: (entries: DevLogEntry[]) => void): () => void;
}

const isHostMessage = (data: unknown): data is HostMessage =>
  typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'state' && 'state' in data;

function createHost(): Host {
  const api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
  const stateListeners = new Set<(state: State) => void>();
  const logListeners = new Set<(entries: DevLogEntry[]) => void>();
  let log: DevLogEntry[] = [];
  let devUiState: unknown;
  /** Dev only: the settings the preview has written, as settings.json would hold them. */
  let devConfig: Record<string, unknown> | undefined;

  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (!isHostMessage(event.data)) return;
    for (const listener of stateListeners) listener(event.data.state);
  });

  // Answers like the real host would, asynchronously, so the UI sees the same message flow.
  const devAnswer = (): void => {
    const state = window.__COCKPIT_DEV_STATE__;
    if (!state) return;
    const message: HostMessage = { type: 'state', state: { ...state, generatedAt: Date.now() } };
    window.postMessage(message, '*');
  };

  // Dev only: edits the preview's ROADMAP.md with the code the real host uses.
  const devRoadmap = (edit: RoadmapEdit): void => {
    const state = window.__COCKPIT_DEV_STATE__;
    if (!state) return;
    let text = window.__COCKPIT_DEV_ROADMAP__;
    if (edit.op === 'create') text ??= starterRoadmap(state.releases.currentVersion);
    else if (text !== undefined) {
      const result = applyRoadmapEdit(text, edit);
      if (result.ok) text = result.text;
      else console.warn(result.error);
    }
    if (text === undefined) return;
    window.__COCKPIT_DEV_ROADMAP__ = text;
    window.__COCKPIT_DEV_STATE__ = { ...state, releases: { ...state.releases, available: true, roadmapExists: true, roadmap: parseRoadmap(text) } };
  };

  // Dev only: writes a setting the way the real host does, and reads them all back.
  const devSetting = (edit: SettingEdit): void => {
    const state = window.__COCKPIT_DEV_STATE__;
    if (!state) return;
    // Starts from the sample's members, the settings it has that are not their defaults.
    devConfig ??= { members: state.settings.members, projectMembers: state.settings.projectMembers };
    const config = devConfig;
    const value = storedValue(edit);
    if (value === undefined) delete config[edit.key];
    else config[edit.key] = value;
    window.__COCKPIT_DEV_STATE__ = { ...state, settings: readSettings((key) => config[key]) };
  };

  return {
    isDev: api === undefined,
    post(message) {
      if (api) {
        api.postMessage(message);
        return;
      }
      log = [...log.slice(-7), { at: Date.now(), message }];
      for (const listener of logListeners) listener(log);
      if (message.type === 'roadmap') devRoadmap(message.edit);
      if (message.type === 'setSetting') devSetting(message.edit);
      const state = window.__COCKPIT_DEV_STATE__;
      if (message.type === 'caughtUp' && state) window.__COCKPIT_DEV_STATE__ = { ...state, caughtUp: markOf(state, Date.now()) };
      if (['ready', 'refresh', 'roadmap', 'setSetting', 'caughtUp'].includes(message.type)) devAnswer();
    },
    onState(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    getUiState: () => (api ? api.getState() : devUiState),
    setUiState(state) {
      if (api) api.setState(state);
      else devUiState = state;
    },
    onDevLog(listener) {
      logListeners.add(listener);
      listener(log);
      return () => logListeners.delete(listener);
    },
  };
}

export const host: Host = createHost();
