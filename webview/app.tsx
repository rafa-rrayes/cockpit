// The page: holds the latest State and the person's UI state (filters, folded groups, the open detail), which
// survives State updates and, inside VS Code, reloads of the webview.
import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { State } from '../src/model';
import { type Cockpit, CockpitContext, type UiState } from './context';
import { host } from './host';
import { Activity } from './sections/Activity';
import { Claudes } from './sections/Claudes';
import { DevLog } from './sections/DevLog';
import { Detail } from './sections/Detail';
import { Header } from './sections/Header';
import { NeedsYou } from './sections/NeedsYou';
import { Releases } from './sections/Releases';
import { Work } from './sections/Work';

const defaultUi: UiState = { filter: 'all', showEnded: false, open: {}, expanded: {} };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// The saved state comes from an older build at times: keep only fields that still make sense.
function restoreUi(saved: unknown): UiState {
  if (!isRecord(saved)) return defaultUi;
  const filter = saved.filter === 'live' || saved.filter === 'waiting' ? saved.filter : 'all';
  const open: Record<string, boolean> = {};
  if (isRecord(saved.open)) for (const [k, v] of Object.entries(saved.open)) if (typeof v === 'boolean') open[k] = v;
  const expanded: UiState['expanded'] = {};
  if (isRecord(saved.expanded)) {
    for (const g of ['active', 'merged', 'stale'] as const) if (saved.expanded[g] === true) expanded[g] = true;
  }
  return {
    filter,
    showEnded: saved.showEnded === true,
    open,
    detail: typeof saved.detail === 'string' ? saved.detail : undefined,
    expanded,
  };
}

export function App(): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const [ui, setUi] = useState<UiState>(() => restoreUi(host.getUiState()));
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const off = host.onState(setState);
    host.post({ type: 'ready' });
    return off;
  }, []);

  useEffect(() => host.setUiState(ui), [ui]);

  // A session that left the State (pruned after its ended window) closes its drawer for good, instead of
  // reopening it should the id come back.
  useEffect(() => {
    if (state && ui.detail && !state.sessions[ui.detail]) setUi((prev) => ({ ...prev, detail: undefined }));
  }, [state, ui.detail]);

  const update = useCallback<Cockpit['update']>((patch) => {
    setUi((prev) => ({ ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) }));
  }, []);

  const openSession = useCallback((sessionId: string) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUi((prev) => ({ ...prev, detail: sessionId }));
  }, []);

  const closeDetail = useCallback(() => {
    setUi((prev) => ({ ...prev, detail: undefined }));
    // After the drawer unmounts and the page is no longer inert.
    requestAnimationFrame(() => {
      const target = returnFocus.current;
      if (target?.isConnected) target.focus();
      returnFocus.current = null;
    });
  }, []);

  const cockpit = useMemo<Cockpit | null>(
    () => (state ? { state, ui, update, post: host.post, openSession } : null),
    [state, ui, update, openSession],
  );

  if (!cockpit) {
    return (
      <div class="app">
        <p class="loading" role="status">
          Reading sessions and repositories…
        </p>
        {host.isDev && <DevLog />}
      </div>
    );
  }

  const detail = ui.detail ? cockpit.state.sessions[ui.detail] : undefined;

  return (
    <CockpitContext.Provider value={cockpit}>
      <div class="app">
        <div class="page" inert={detail !== undefined}>
          <Header />
          <main class="sections">
            <NeedsYou />
            <Claudes />
            {cockpit.state.work.available && <Work />}
            {cockpit.state.releases.available && <Releases />}
            <Activity />
          </main>
        </div>
        {detail && <Detail session={detail} onClose={closeDetail} />}
        {host.isDev && <DevLog />}
      </div>
    </CockpitContext.Provider>
  );
}
