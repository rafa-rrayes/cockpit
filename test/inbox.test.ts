import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentAction, AgentResult } from '../src/agent';
import { type Disposable, inboxDir, NoCockpitError, sendRequest, watchInbox } from '../src/inbox';

let root: string;
const watches: Disposable[] = [];
const quiet = () => undefined;
const fast = { pollMs: 20 };

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

const watching = async (handle: (a: AgentAction) => Promise<AgentResult>): Promise<void> => {
  watches.push(watchInbox(root, handle, quiet));
  await until(() => existsSync(inboxDir(root)));
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-inbox-'));
});

afterEach(() => {
  for (const w of watches.splice(0)) w.dispose();
  rmSync(root, { recursive: true, force: true });
});

describe('the inbox', () => {
  it('carries a request to the window and its answer back, and leaves nothing behind', async () => {
    const seen: AgentAction[] = [];
    await watching(async (a) => {
      seen.push(a);
      return { ok: true, lines: ['merged', 'done'] };
    });
    expect(readFileSync(join(root, '.cockpit', '.gitignore'), 'utf8')).toBe('*\n');
    const result = await sendRequest(root, { verb: 'ship', branch: 'worktree-x' }, fast);
    expect(result).toEqual({ ok: true, lines: ['merged', 'done'] });
    expect(seen).toEqual([{ verb: 'ship', branch: 'worktree-x' }]);
    await until(() => readdirSync(inboxDir(root)).length === 0);
  });

  it('fails at once when no window ever watched the repository', async () => {
    const started = Date.now();
    await expect(sendRequest(root, { verb: 'status' }, fast)).rejects.toThrow(new NoCockpitError(`No VS Code window with Cockpit is open on ${root}.`));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('takes back a request nobody claims', async () => {
    mkdirSync(inboxDir(root), { recursive: true });
    await expect(sendRequest(root, { verb: 'status' }, { ...fast, unclaimedMs: 200 })).rejects.toBeInstanceOf(NoCockpitError);
    expect(readdirSync(inboxDir(root))).toEqual([]);
  });

  it('runs a request in one window when two watch the same repository', async () => {
    let runs = 0;
    const handle = async (): Promise<AgentResult> => {
      runs++;
      return { ok: true, lines: [] };
    };
    await watching(handle);
    await watching(handle);
    await Promise.all([1, 2, 3, 4, 5].map(() => sendRequest(root, { verb: 'status' }, fast)));
    expect(runs).toBe(5);
  });

  it('answers a request it cannot read with an error, and an action that throws with its message', async () => {
    await watching(async () => {
      throw new Error('the merge failed');
    });
    writeFileSync(join(inboxDir(root), 'bad.json'), '{"verb":"rm","path":"/"}');
    await until(() => existsSync(join(inboxDir(root), 'bad.out')));
    const answer = JSON.parse(readFileSync(join(inboxDir(root), 'bad.out'), 'utf8')) as AgentResult;
    expect(answer.ok).toBe(false);
    expect(answer.lines[0]).toContain('could not read this request');
    expect(await sendRequest(root, { verb: 'pull' }, fast)).toEqual({ ok: false, lines: ['Cockpit: the merge failed'] });
  });

  it('says when it waits on the window, and gives up on one that never answers', async () => {
    await watching(() => new Promise<AgentResult>(() => undefined));
    let waiting = 0;
    const result = await sendRequest(root, { verb: 'release', version: '1.0.0' }, { ...fast, waitingMs: 100, claimedMs: 400, onWaiting: () => waiting++ });
    expect(waiting).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.lines[0]).toContain('gave no answer');
  });

  it('removes leftovers older than an hour', async () => {
    const dir = inboxDir(root);
    mkdirSync(dir, { recursive: true });
    const old = join(dir, 'gone.out');
    const fresh = join(dir, 'kept.out');
    writeFileSync(old, '{}');
    writeFileSync(fresh, '{}');
    const hourAgo = (Date.now() - 2 * 3_600_000) / 1000;
    utimesSync(old, hourAgo, hourAgo);
    await watching(async () => ({ ok: true, lines: [] }));
    await until(() => !existsSync(old));
    expect(existsSync(fresh)).toBe(true);
  });
});
