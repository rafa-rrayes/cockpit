// What every section reads: the State, the UI state and the ways to act on them.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import type { LaunchOptions, State, WebviewMessage, WorkGroup } from '../src/model';

export type SessionFilter = 'all' | 'live' | 'waiting';

export interface UiState {
  filter: SessionFilter;
  showEnded: boolean;
  /** Project groups the person opened (true) or folded (false), by Project.key. Absent: the default. */
  open: Record<string, boolean>;
  /** The session shown in the detail drawer. */
  detail?: string;
  /** Work columns showing every item instead of the first few. */
  expanded: Partial<Record<WorkGroup, boolean>>;
  /** The options the last Claude was started from the roadmap with: the launcher opens with them. */
  launch?: LaunchOptions;
}

export interface Cockpit {
  state: State;
  ui: UiState;
  update(patch: Partial<UiState> | ((ui: UiState) => Partial<UiState>)): void;
  post(message: WebviewMessage): void;
  /** Opens a session's detail drawer; focus returns to the element that opened it when it closes. */
  openSession(sessionId: string): void;
  /** Opens the Catch up drawer; closing it counts what it showed as seen. */
  openCatchUp(): void;
}

export const CockpitContext = createContext<Cockpit | null>(null);

export function useCockpit(): Cockpit {
  const value = useContext(CockpitContext);
  if (!value) throw new Error('useCockpit outside <App>');
  return value;
}

