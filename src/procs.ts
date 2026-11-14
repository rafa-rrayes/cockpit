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
