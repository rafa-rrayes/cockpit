import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { managedDir, parseManaged, readManaged, updateManaged, type ManagedRecord, writeManaged } from '../src/data/managed';
import { runManaged } from '../src/runner';
import { managedTerminal } from '../src/managedLaunch';

const dirs: string[] = [];
const originalHome = process.env.COCKPIT_HOME;
afterEach(async () => {
  if (originalHome === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = originalHome;
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function home() { const dir = await mkdtemp(join(tmpdir(), 'cockpit-managed-test-')); dirs.push(dir); process.env.COCKPIT_HOME = dir; return dir; }
const record = (over: Partial<ManagedRecord> = {}): ManagedRecord => ({ id: 'test-id', provider: 'custom-agent', pid: 123, cwd: '/work/app', title: 'A task', startedAt: 100_000, updatedAt: 101_000, status: 'unknown', ...over });

describe('portable agent sessions', () => {
  it('verifies the process identity; recency does not make a dead process live', async () => {
    await home(); const path = join(managedDir(), 'test-id.json');
    await writeManaged(path, record());
    const opts = { now: 102_000, endedSessionDays: 1 };
    const [live] = await readManaged({ ...opts, processStarts: async () => new Map([[123, 100_000]]) });
    expect(live).toMatchObject({ provider: 'custom-agent', live: true, status: 'unknown', canResume: false });
    expect(live?.statusNote).toContain('activity is not reported');
    const [reused] = await readManaged({ ...opts, processStarts: async () => new Map([[123, 200_000]]) });
    expect(reused).toMatchObject({ live: false, status: 'ended' });
    const [uncertain] = await readManaged({ ...opts, processStarts: async () => undefined });
    expect(uncertain).toMatchObject({ live: false, status: 'unknown' });
  });

  it('hook updates waiting, native session ID and report without guessing status', async () => {
    await home(); const file = join(managedDir(), 'test-id.json'); await writeManaged(file, record());
    const env = { COCKPIT_SESSION_FILE: file };
    expect((await updateManaged(['waiting', 'Permission required'], env)).ok).toBe(true);
    await updateManaged(['id', 'native-123'], env);
    await updateManaged(['report', 'Verified and finished.'], env);
    const [s] = await readManaged({ now: Date.now(), endedSessionDays: 1, processStarts: async () => new Map([[123, 100_000]]) });
    expect(s).toMatchObject({ status: 'waiting', waitingFor: 'Permission required', nativeSessionId: 'native-123', canResume: true, report: 'Verified and finished.' });
    await updateManaged(['idle'], env);
    expect(parseManaged(await readFile(file, 'utf8'))?.waitingFor).toBeUndefined();
  });

  it('does not edit files outside the managed sessions directory or ended sessions', async () => {
    const dir = await home(); const path = join(dir, 'important.json'); await writeFile(path, 'keep me');
    expect((await updateManaged(['busy'], { COCKPIT_SESSION_FILE: path })).ok).toBe(false);
    expect(await readFile(path, 'utf8')).toBe('keep me');
    const ended = join(managedDir(), 'test-id.json'); await writeManaged(ended, record({ endedAt: 110_000 }));
    expect((await updateManaged(['busy'], { COCKPIT_SESSION_FILE: ended })).ok).toBe(false);
  });

  it('a malformed manifest cannot hide healthy providers or sessions', async () => {
    await home(); await writeManaged(join(managedDir(), 'test-id.json'), record());
    await writeFile(join(managedDir(), 'broken.json'), '{');
    await writeFile(join(managedDir(), 'bad.json'), JSON.stringify(record({ prompt: [] as unknown as string })));
    const ss = await readManaged({ now: 102_000, endedSessionDays: 1, processStarts: async () => new Map() });
    expect(ss).toHaveLength(1);
  });

  it('actually runs an arbitrary executable, exposes hooks and records the exit', async () => {
    const dir = await home();
    const marker = join(dir, 'marker.txt');
    const code = await runManaged({ provider: 'test-agent', command: process.execPath,
      args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],process.env.COCKPIT_AGENT+"\\n"+process.env.COCKPIT_SESSION_FILE);process.exitCode=7', marker],
      cwd: dir, title: 'A harmless local test' });
    expect(code).toBe(7);
    const [provider, file] = (await readFile(marker, 'utf8')).split('\n');
    expect(provider).toBe('test-agent');
    const r = parseManaged(await readFile(file!, 'utf8'));
    expect(r).toMatchObject({ status: 'ended', exitCode: 7 });
    const [s] = await readManaged({ now: Date.now(), endedSessionDays: 1 });
    expect(s).toMatchObject({ live: false, status: 'ended' });
    expect((await readdir(managedDir())).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('argv stays intact through the Electron-as-Node wrapper', () => {
    const args = ['$(touch stolen)', 'a prompt with spaces', '"quoted"'];
    const launch = managedTerminal('/path/to/agent', args, { provider: 'custom', cwd: '/work', title: 'Task' });
    expect(JSON.parse(launch.shellArgs[1]!)).toMatchObject({ command: '/path/to/agent', args });
    expect(launch.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });
});
