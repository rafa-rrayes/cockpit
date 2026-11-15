// What a Claude asks of Cockpit through the `cockpit` command (src/cli.ts): the request, the answer, and the words
// of `cockpit status`. Pure (no node, no vscode): actions.ts runs the request, inbox.ts carries it.
import type { State } from './model';

export type AgentAction =
  | { verb: 'status' }
  | { verb: 'ship'; branch: string }
  | { verb: 'release'; version: string }
  | { verb: 'tag'; version: string }
  | { verb: 'pull' }
  | { verb: 'add'; lane: string; text: string }
  | { verb: 'lane'; version: string; title?: string };

/** What the command prints, a line each; `ok` false makes it exit 1. */
export interface AgentResult {
  ok: boolean;
  lines: string[];
}

/** `cockpit status`: the board and what can be done next. A stub until 0.3.0's brief B fills it in. */
export function statusLines(_state: State): string[] {
  return [];
}
