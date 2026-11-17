import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ClaudeSession, SessionStatus } from '../model';
import { readProcessStarts } from '../procs';

export const managedDir = (): string => join(process.env.COCKPIT_HOME || join(homedir(), '.cockpit'), 'sessions');
const MAX_BYTES = 64 * 1024;
const STATUSES = new Set<SessionStatus>(['busy', 'waiting', 'idle', 'unknown', 'ended']);

export interface ManagedRecord {
  id: string;
  provider: string;
  nativeSessionId?: string;
  pid: number;
  cwd: string;
  title: string;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  status: SessionStatus;
  waitingFor?: string;
  prompt?: string;
  report?: string;
  exitCode?: number;
}

export async function writeManaged(path: string, record: ManagedRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(record), { encoding: 'utf8', mode: 0o600 });
  await rename(tmp, path);
}

export function parseManaged(raw: string): ManagedRecord | undefined {
  try {
    const r = JSON.parse(raw) as ManagedRecord;
    if (!r || typeof r !== 'object' || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.id) ||
      typeof r.provider !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(r.provider) ||
      !Number.isSafeInteger(r.pid) || r.pid <= 0 || typeof r.cwd !== 'string' || !isAbsolute(r.cwd) ||
      typeof r.title !== 'string' || !Number.isFinite(r.startedAt) || !Number.isFinite(r.updatedAt) || !STATUSES.has(r.status)) return undefined;
    for (const key of ['nativeSessionId', 'waitingFor', 'prompt', 'report'] as const) if (r[key] !== undefined && typeof r[key] !== 'string') return undefined;
    if (r.endedAt !== undefined && !Number.isFinite(r.endedAt)) return undefined;
    return r;
  } catch { return undefined; }
}

export async function readManaged(opts: { dir?: string; endedSessionDays: number; now: number; resolveProjectKey?: (cwd: string) => Promise<string>; processStarts?: typeof readProcessStarts }): Promise<ClaudeSession[]> {
  const dir = opts.dir ?? managedDir();
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => /^[a-zA-Z0-9_-]{1,100}\.json$/.test(n));
  const records: ManagedRecord[] = [];
  // Bound open descriptors, even if many launches have accumulated.
  for (let i = 0; i < names.length; i += 24) {
    const batch = await Promise.all(names.slice(i, i + 24).map(async (name) => {
      const path = join(dir, name);
      const st = await stat(path).catch(() => undefined);
      if (!st || st.size > MAX_BYTES) return undefined;
      return parseManaged(await readFile(path, 'utf8').catch(() => ''));
    }));
    records.push(...batch.filter((r): r is ManagedRecord => r !== undefined));
  }
  const starts = await (opts.processStarts ?? readProcessStarts)(records.filter((r) => !r.endedAt).map((r) => r.pid));
  const out: ClaudeSession[] = [];
  const projects = new Map<string, Promise<string>>();
  for (const r of records) {
    const start = starts?.get(r.pid);
    // A status file is not a heartbeat. Check process identity, never recent mtime alone.
    const alive = !r.endedAt && start !== undefined && Math.abs(start - r.startedAt) <= 30_000;
    const uncertain = !r.endedAt && starts === undefined;
    if (!alive && !uncertain && r.updatedAt < opts.now - opts.endedSessionDays * 86_400_000) continue;
    let project = projects.get(r.cwd);
    if (!project) { project = opts.resolveProjectKey?.(r.cwd).catch(() => r.cwd) ?? Promise.resolve(r.cwd); projects.set(r.cwd, project); }
    out.push({
      sessionId: `managed:${r.id}`, provider: r.provider, nativeSessionId: r.nativeSessionId,
      live: alive, pid: alive ? r.pid : undefined,
      status: alive ? (r.status === 'ended' ? 'unknown' : r.status) : uncertain ? 'unknown' : 'ended',
      statusNote: alive && r.status === 'unknown' ? 'Process is running; activity is not reported by this agent.' : uncertain ? 'Process status is unavailable on this system.' : undefined,
      waitingFor: alive && r.status === 'waiting' ? r.waitingFor : undefined,
      title: r.title, cwd: r.cwd, projectKey: await project,
      lastPrompt: r.prompt?.slice(0, 300), recentPrompts: r.prompt ? [r.prompt.slice(0, 300)] : [],
      report: typeof r.report === 'string' ? r.report.slice(0, 20_000) : undefined,
      startedAt: r.startedAt, updatedAt: r.updatedAt, canResume: Boolean(r.nativeSessionId),
      subagents: [], workflows: [],
    });
  }
  return out;
}

/** A hook can only edit the manifest the launcher explicitly handed to it, never an arbitrary file. */
export async function updateManaged(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; message: string }> {
  const file = env.COCKPIT_SESSION_FILE;
  if (!file || dirname(resolve(file)) !== resolve(managedDir())) return { ok: false, message: 'This agent was not started through Cockpit. Use `cockpit run <agent> -- <command> [args…]`.' };
  const st = await stat(file).catch(() => undefined);
  const r = st && st.size <= MAX_BYTES ? parseManaged(await readFile(file, 'utf8').catch(() => '')) : undefined;
  if (!r || r.endedAt) return { ok: false, message: 'The Cockpit session is missing or has ended.' };
  const [verb, ...rest] = argv;
  const value = rest.join(' ').trim();
  if (verb === 'id' && value && value.length <= 200 && !/[\r\n]/.test(value)) r.nativeSessionId = value;
  else if (verb === 'report' && value && value.length <= 20_000) r.report = value;
  else if (verb && STATUSES.has(verb as SessionStatus) && verb !== 'ended') {
    r.status = verb as SessionStatus;
    r.waitingFor = verb === 'waiting' ? value.slice(0, 1000) || 'Agent needs your attention' : undefined;
  } else return { ok: false, message: 'Usage: cockpit session <busy|waiting|idle|unknown> [detail] | id <native-session-id> | report <text>' };
  r.updatedAt = Date.now();
  await writeManaged(file, r);
  return { ok: true, message: 'Cockpit session updated.' };
}
