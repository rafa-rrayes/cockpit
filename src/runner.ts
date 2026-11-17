import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { managedDir, parseManaged, type ManagedRecord, writeManaged } from './data/managed';
import type { ManagedLaunch } from './managedLaunch';

export async function runManaged(launch: ManagedLaunch): Promise<number> {
  if (!launch || typeof launch.command !== 'string' || !launch.command || /[\r\n\0]/.test(launch.command) ||
    !Array.isArray(launch.args) || !launch.args.every((a) => typeof a === 'string' && !a.includes('\0')) ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(launch.provider) || !isAbsolute(launch.cwd) || typeof launch.title !== 'string') throw new Error('Invalid agent launch.');
  const now = Date.now();
  const record: ManagedRecord = { id: randomUUID(), provider: launch.provider, nativeSessionId: launch.nativeSessionId,
    pid: process.pid, cwd: launch.cwd, title: launch.title.slice(0, 200), startedAt: now, updatedAt: now,
    status: 'unknown', prompt: launch.prompt?.slice(0, 300) };
  const file = join(managedDir(), `${record.id}.json`);
  await writeManaged(file, record);
  const env: NodeJS.ProcessEnv = { ...process.env, COCKPIT_SESSION_FILE: file, COCKPIT_AGENT: launch.provider };
  // Only the wrapper needs Electron's Node switch. Do not change the behavior of an Electron-based agent.
  delete env.ELECTRON_RUN_AS_NODE;
  const code = await new Promise<number>((resolve) => {
    const child = spawn(launch.command, launch.args, { cwd: launch.cwd, env, stdio: 'inherit', shell: false });
    const forward = (signal: NodeJS.Signals) => { child.kill(signal); };
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    for (const signal of signals) process.on(signal, forward);
    const finish = (exit: number) => { for (const signal of signals) process.off(signal, forward); resolve(exit); };
    child.once('error', (e) => { process.stderr.write(`Cockpit could not start ${launch.provider}: ${e.message}\n`); finish(127); });
    child.once('exit', (exit, signal) => finish(exit ?? (signal === 'SIGINT' ? 130 : 1)));
  });
  const latest = parseManaged(await readFile(file, 'utf8').catch(() => '')) ?? record;
  await writeManaged(file, { ...latest, status: 'ended', endedAt: Date.now(), updatedAt: Date.now(), exitCode: code });
  return code;
}

// Bundled separately for terminals; importing it from the cockpit CLI does not launch anything.
if (process.argv[1] && /(?:^|[/\\])runner\.js$/.test(process.argv[1])) {
  void Promise.resolve().then(() => runManaged(JSON.parse(process.argv[2] ?? ''))).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => { process.stderr.write(`Cockpit: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; },
  );
}
