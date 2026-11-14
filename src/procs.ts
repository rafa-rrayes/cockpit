// The process tree, to tell whether a Claude runs inside one of this window's terminals: VS Code gives each
// terminal's shell pid, Claude Code's session file gives the claude pid, and the shell is one of its ancestors.
import { run } from './data/git';

/** Parses `ps -A -o pid= -o ppid=`: pid → parent pid. */
export function parsePsTable(text: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (m) parents.set(Number(m[1]), Number(m[2]));
  }
  return parents;
}

/** The ancestors of `pid`, nearest first, stopping at init or at a loop. */
export function ancestorsOf(pid: number, parents: Map<number, number>): number[] {
  const out: number[] = [];
  const seen = new Set([pid]);
  let cur = parents.get(pid);
  while (cur !== undefined && cur > 1 && !seen.has(cur)) {
    out.push(cur);
    seen.add(cur);
    cur = parents.get(cur);
  }
  return out;
}

/** The whole table in one command; empty where ps is missing (Windows) or fails. */
export async function readProcessTable(): Promise<Map<number, number>> {
  if (process.platform === 'win32') return new Map();
  const r = await run('ps', ['-A', '-o', 'pid=', '-o', 'ppid='], { timeoutMs: 5000 });
  return r.ok ? parsePsTable(r.stdout) : new Map();
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri Nov 13 04:50:01 2026", read as UTC: the shape of ps's lstart under TZ=UTC0, and of the procStart that
 *  Claude Code writes into sessions/<pid>.json. */
export function parseLstart(text: string): number | undefined {
  const m = /^\s*[A-Z][a-z]{2}\s+([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})\s*$/.exec(text);
  const month = m ? MONTHS.indexOf(m[1] as string) : -1;
  if (!m || month < 0) return undefined;
  return Date.UTC(Number(m[6]), month, Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/** Parses `ps -o pid= -o lstart=` (run with TZ=UTC0): pid → start time in epoch ms. */
export function parseProcessStarts(text: string): Map<number, number> {
  const starts = new Map<number, number>();
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    const at = m ? parseLstart(m[2] as string) : undefined;
    if (m && at !== undefined) starts.set(Number(m[1]), at);
  }
  return starts;
}

/** When each of `pids` started, to tell a live process from a later one that reused its pid. A pid missing from
 *  the map has no process. Undefined when ps is unavailable (Windows) or fails: the caller cannot tell. */
export async function readProcessStarts(pids: number[]): Promise<Map<number, number> | undefined> {
  if (process.platform === 'win32') return undefined;
  if (pids.length === 0) return new Map();
  const r = await run('ps', ['-o', 'pid=', '-o', 'lstart=', '-p', pids.join(',')], { timeoutMs: 5000, env: { TZ: 'UTC0', LC_ALL: 'C' } });
  // ps exits 1 when none of the pids exists, with nothing on stdout: that is an answer, not a failure.
  if (!r.ok && (r.timedOut || r.stdout.trim() !== '' || r.stderr.trim() !== '')) return undefined;
  return parseProcessStarts(r.stdout);
}
