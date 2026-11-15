// Browser preview: provides the State the extension host would send, then starts the real webview bundle.
// dev.html?state=<url> previews a State JSON captured elsewhere; dev.html?theme=light switches the theme.
import type { State } from '../src/model';
import { defaultSettings } from '../src/settings';
import { sampleRoadmap, sampleState } from './sample-state';

async function loadState(): Promise<State> {
  const url = new URLSearchParams(location.search).get('state');
  if (!url) {
    window.__COCKPIT_DEV_ROADMAP__ = sampleRoadmap;
    return sampleState();
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  // A State captured before settings were part of it.
  const state = (await response.json()) as State;
  return { ...state, settings: state.settings ?? defaultSettings };
}

function start(state: State): void {
  window.__COCKPIT_DEV_STATE__ = state;
  const script = document.createElement('script');
  script.src = 'webview.js';
  document.body.appendChild(script);
}

function fail(error: unknown): void {
  const message = document.createElement('p');
  message.className = 'dev-error';
  message.textContent = `Could not load the State: ${error instanceof Error ? error.message : String(error)}`;
  (document.getElementById('root') ?? document.body).appendChild(message);
}

const theme = new URLSearchParams(location.search).get('theme') === 'light' ? 'vscode-light' : 'vscode-dark';
document.body.classList.add(theme);
document.body.dataset.vscodeThemeKind = theme;

loadState().then(start, fail);
