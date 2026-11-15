// The mailbox between the `cockpit` command and the VS Code window that runs Cockpit on the same repository:
// request files in `<repoRoot>/.cockpit/inbox/`. Node only, no `vscode`.
//
//   <id>.json  a request (an AgentAction), written by the command (temp file + rename)
//   <id>.run   the same request, claimed by one window: renaming is atomic, so of two windows on one repository
//              only one wins it
//   <id>.out   the answer (an AgentResult), written by that window; the command reads it and deletes it
import { randomBytes } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type AgentAction, type AgentResult, parseRequest } from './agent';
import { COCKPIT_DIR, ensureCockpitDir } from './data/cockpitDir';

export const inboxDir = (root: string): string => join(root, COCKPIT_DIR, 'inbox');

const REQUEST = /^([A-Za-z0-9-]{1,64})\.json$/;
/** Inbox files older than this are left over from a crash or a window that closed mid-request. */
const STALE_MS = 3_600_000;

/** No window answered: Cockpit is not running on this repository. */
export class NoCockpitError extends Error {}

async function writeAtomic(path: string, text: string): Promise<void> {
  // A name the watcher ignores until the rename gives it its real one, whole.
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, text, 'utf8');
  await rename(tmp, path);
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

const isResult = (v: unknown): v is AgentResult =>
  typeof v === 'object' && v !== null && typeof (v as AgentResult).ok === 'boolean' && Array.isArray((v as AgentResult).lines) && (v as AgentResult).lines.every((l) => typeof l === 'string');

export interface SendOptions {
  /** Called once when a claimed request has not been answered after `waitingMs` (a dialog may be open). */
  onWaiting?: () => void;
  /** How long a request may stay unclaimed before no window counts as open. */
  unclaimedMs?: number;
  /** How long a claimed request may take. */
  claimedMs?: number;
  waitingMs?: number;
  pollMs?: number;
}

/** Asks the window watching `root`'s inbox to run `action`, and waits for its answer. Throws NoCockpitError when
 *  no window claims it in time. */
export async function sendRequest(root: string, action: AgentAction, opts: SendOptions = {}): Promise<AgentResult> {
  const { unclaimedMs = 5000, claimedMs = 600_000, waitingMs = 2000, pollMs = 100 } = opts;
  const dir = inboxDir(root);
  const noWindow = new NoCockpitError(`No VS Code window with Cockpit is open on ${root}.`);
  // A window running Cockpit makes the inbox as it starts watching: without it, nobody is listening.
  if (!(await exists(dir))) throw noWindow;
  const id = `${Date.now()}-${randomBytes(6).toString('hex')}`;
  const request = join(dir, `${id}.json`);
  const answer = join(dir, `${id}.out`);
  await writeAtomic(request, JSON.stringify(action));

  const started = Date.now();
  let warned = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    if (await exists(answer)) {
      const text = await readFile(answer, 'utf8');
      await rm(answer, { force: true });
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      return isResult(parsed) ? parsed : { ok: false, lines: ['Cockpit answered with something that is not an answer.'] };
    }
    const waited = Date.now() - started;
    if (await exists(request)) {
      if (waited < unclaimedMs) continue;
      // Removing it settles the race with a window claiming it right now: if the rename won, rm finds nothing.
      const removed = await rm(request).then(
        () => true,
        () => false,
      );
      if (removed) throw noWindow;
      continue;
    }
    if (!warned && waited >= waitingMs) {
      warned = true;
      opts.onWaiting?.();
    }
    if (waited >= claimedMs) {
      await rm(join(dir, `${id}.run`), { force: true });
      return { ok: false, lines: [`Cockpit took the request but gave no answer in ${Math.round(claimedMs / 60_000)} minutes.`] };
    }
  }
}

export interface Disposable {
  dispose(): void;
}

/** Watches `root`'s inbox and answers each request with `handle`, one at a time, in the order they are claimed.
 *  A request that does not parse is answered with an error. Old leftovers are removed. */
export function watchInbox(root: string, handle: (action: AgentAction) => Promise<AgentResult>, log: (line: string) => void): Disposable {
  const dir = inboxDir(root);
  let disposed = false;
  let watcher: FSWatcher | undefined;
  let queue: Promise<void> = Promise.resolve();
  let scanning = false;
  let again = false;

  const answer = async (id: string): Promise<void> => {
    const run = join(dir, `${id}.run`);
    let result: AgentResult;
    try {
      const action = parseRequest(await readFile(run, 'utf8'));
      result = action ? await handle(action) : { ok: false, lines: ['Cockpit could not read this request: update the cockpit command, or check its arguments.'] };
    } catch (e) {
      result = { ok: false, lines: [`Cockpit: ${e instanceof Error ? e.message : String(e)}`] };
    }
    try {
      await writeAtomic(join(dir, `${id}.out`), JSON.stringify(result));
    } catch (e) {
      log(`cockpit inbox: could not answer ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await rm(run, { force: true });
  };

  const scanOnce = async (): Promise<void> => {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    const now = Date.now();
    for (const n of names) {
      if (disposed) return;
      const m = REQUEST.exec(n);
      if (m?.[1]) {
        const id = m[1];
        // Claim it: of two windows, the rename succeeds for one.
        const claimed = await rename(join(dir, n), join(dir, `${id}.run`)).then(
          () => true,
          () => false,
        );
        if (claimed) queue = queue.then(() => answer(id));
        continue;
      }
      const s = await stat(join(dir, n)).catch(() => undefined);
      if (s?.isFile() && now - s.mtimeMs > STALE_MS) await rm(join(dir, n), { force: true });
    }
  };

  const scan = (): void => {
    if (disposed) return;
    if (scanning) {
      again = true;
      return;
    }
    scanning = true;
    void scanOnce()
      .catch((e: unknown) => log(`cockpit inbox: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => {
        scanning = false;
        if (again) {
          again = false;
          scan();
        }
      });
  };

  // fs.watch can miss events (network drives, some editors' file systems): a slow scan backs it up, well inside the
  // five seconds a request waits to be claimed.
  const timer = setInterval(scan, 1500);
  timer.unref?.();

  void ensureCockpitDir(root)
    .then(() => mkdir(dir, { recursive: true }))
    .then(() => {
      if (disposed) return;
      try {
        watcher = watch(dir, scan);
        watcher.on('error', (e) => log(`cockpit inbox: ${e.message}`));
      } catch (e) {
        log(`cockpit inbox: cannot watch ${dir}: ${e instanceof Error ? e.message : String(e)}`);
      }
      scan();
    })
    .catch((e: unknown) => log(`cockpit inbox: cannot make ${dir}: ${e instanceof Error ? e.message : String(e)}`));

  return {
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      watcher?.close();
    },
  };
}
