// Gemini and OpenCode saved-session discovery. History alone cannot establish whether a process is alive:
// these records deliberately carry unknown status until a Cockpit-managed process supplies runtime telemetry.
// Formats: geminicli.com/docs/cli/session-management and Gemini's chatRecordingTypes.ts / projectRegistry.ts;
// OpenCode exposes its supported JSON listing through `opencode session list`.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { AgentSession } from '../model';
import { run } from './git';

type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === 'string' && v.trim() ? v.trim() : undefined;
const parse = (s: string): unknown => { try { return JSON.parse(s); } catch { return undefined; } };
const cut = (s: string, n: number): string => s.length > n ? `${s.slice(0, n - 1)}…` : s;
const at = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(v);
const DAY = 86_400_000;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_SESSIONS = 500;
export const HISTORY_STATUS_NOTE = 'History only; live status unavailable. Start through Cockpit to track the process.';

export interface ReadOtherAgentsOptions {
  endedSessionDays: number;
  now: number;
  resolveProjectKey?: (cwd: string) => Promise<string>;
  geminiDir?: string;
  opencodeCommand?: string;
}

function historySession(provider: string, nativeId: string, cwd: string, title: string): AgentSession {
  return { provider, nativeSessionId: nativeId, sessionId: `${provider}:${nativeId}`, cwd, projectKey: cwd, title,
    live: false, status: 'unknown', statusNote: HISTORY_STATUS_NOTE, canResume: true, recentPrompts: [], subagents: [], workflows: [] };
}

function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!Array.isArray(value)) return obj(value) ? str(value.text) : undefined;
  const text = value.slice(0, 1000).map((p) => typeof p === 'string' ? p : obj(p) ? str(p.text) ?? '' : '').filter(Boolean).join('\n').trim();
  return text || undefined;
}

/** Old JSON snapshots and current append-only JSONL (including metadata updates, patches and rewinds). */
export function parseGeminiSession(text: string, cwd: string, transcriptPath?: string): AgentSession | undefined {
  if (!isAbsolute(cwd)) return undefined;
  let metadata: Json = {};
  let messages: Json[] = [];
  const snapshot = parse(text);
  if (obj(snapshot) && Array.isArray(snapshot.messages)) {
    metadata = snapshot;
    messages = snapshot.messages.filter(obj);
  } else {
    for (const line of text.split('\n')) {
      const record = parse(line);
      if (!obj(record)) continue;
      if (obj(record.$set)) {
        metadata = { ...metadata, ...record.$set };
        if (Array.isArray(record.$set.messages)) messages = record.$set.messages.filter(obj);
      } else if (str(record.sessionId)) metadata = { ...metadata, ...record };
      else if (str(record.$rewindTo)) {
        const index = messages.findIndex((m) => m.id === record.$rewindTo);
        if (index >= 0) messages = messages.slice(0, index);
      } else if (obj(record.$patch)) {
        const patch = record.$patch;
        const updates = Array.isArray(patch.updates) ? patch.updates.filter(obj) : str(patch.id) ? [patch] : [];
        for (const update of updates) messages = messages.map((m) => m.id === update.id ? { ...m, ...update } : m);
        if (Array.isArray(patch.removeIds)) { const removed = new Set(patch.removeIds); messages = messages.filter((m) => !removed.has(m.id)); }
        if (Array.isArray(patch.orderIds)) {
          const byId = new Map(messages.map((m) => [m.id, m]));
          messages = patch.orderIds.flatMap((i) => { const m = byId.get(i); return m ? [m] : []; });
        }
      } else if (str(record.id) && (record.type === 'user' || record.type === 'gemini')) messages.push(record);
    }
  }
  if (!id(metadata.sessionId) || metadata.kind === 'subagent') return undefined;
  const prompts = messages.filter((m) => m.type === 'user').map((m) => messageText(m.displayContent ?? m.content)).filter((s): s is string => !!s);
  const report = [...messages].reverse().find((m) => m.type === 'gemini' && messageText(m.content));
  const lastPrompt = prompts.at(-1);
  const s = historySession('gemini', metadata.sessionId, cwd, cut(str(metadata.summary) ?? lastPrompt ?? 'Gemini session', 120));
  s.startedAt = at(metadata.startTime);
  s.updatedAt = at(metadata.lastUpdated) ?? messages.map((m) => at(m.timestamp)).filter((t): t is number => t !== undefined).at(-1) ?? s.startedAt;
  s.lastPrompt = lastPrompt ? cut(lastPrompt.replace(/\s+/g, ' '), 300) : undefined;
  s.recentPrompts = prompts.slice(-5).reverse().map((p) => cut(p.replace(/\s+/g, ' '), 300));
  if (report) s.report = cut(messageText(report.content)!, 20_000);
  if (transcriptPath) s.transcriptPath = transcriptPath;
  return s;
}

/** The stable CLI JSON list contains metadata, not message content or a live-state assertion. */
export function parseOpenCodeSessions(text: string): AgentSession[] {
  const rows = parse(text);
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, MAX_SESSIONS).filter(obj).flatMap((row) => {
    const cwd = str(row.directory);
    if (!id(row.id) || !cwd || !isAbsolute(cwd)) return [];
    const s = historySession('opencode', row.id, cwd, cut(str(row.title) ?? 'OpenCode session', 120));
    s.startedAt = at(row.created) ?? (obj(row.time) ? at(row.time.created) : undefined);
    s.updatedAt = at(row.updated) ?? (obj(row.time) ? at(row.time.updated) : undefined) ?? s.startedAt;
    return [s];
  });
}

const fileCache = new Map<string, { size: number; mtime: number; value?: AgentSession }>();
const listCache = new Map<string, { until: number; sessions: AgentSession[] }>();
export function resetOtherAgentCache(): void { fileCache.clear(); listCache.clear(); }

async function boundedText(path: string, limit = MAX_BYTES): Promise<string | undefined> {
  const file = await open(path, 'r').catch(() => undefined);
  if (!file) return undefined;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) return undefined;
    // Read only the observed size, so a concurrently growing transcript cannot exceed the allocation bound.
    const buffer = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } catch { return undefined; } finally { await file.close(); }
}

async function readGemini(opts: ReadOtherAgentsOptions): Promise<AgentSession[]> {
  const root = opts.geminiDir ?? join(homedir(), '.gemini');
  const registry = parse(await boundedText(join(root, 'projects.json'), 1024 * 1024) ?? '');
  const projects = obj(registry) && obj(registry.projects) ? registry.projects : {};
  const pathsBySlug = new Map(Object.entries(projects).filter(([path, slug]) => isAbsolute(path) && typeof slug === 'string').map(([path, slug]) => [slug as string, path]));
  const tmp = join(root, 'tmp');
  const dirs = await readdir(tmp, { withFileTypes: true }).catch(() => []);
  const files: { path: string; cwd: string; mtime: number; size: number }[] = [];
  for (const d of dirs.filter((d) => d.isDirectory()).slice(0, 1000)) {
    const dir = join(tmp, d.name);
    const marker = (await boundedText(join(dir, '.project_root'), 16_384))?.trim();
    const cwd = marker && isAbsolute(marker) ? marker : pathsBySlug.get(d.name);
    if (!cwd) continue;
    const chats = await readdir(join(dir, 'chats'), { withFileTypes: true }).catch(() => []);
    for (const f of chats.filter((f) => f.isFile() && /^session-.*\.jsonl?$/.test(f.name)).slice(0, MAX_SESSIONS)) {
      const path = join(dir, 'chats', f.name);
      const info = await stat(path).catch(() => undefined);
      if (info && info.size <= MAX_BYTES && info.mtimeMs >= opts.now - opts.endedSessionDays * DAY) files.push({ path, cwd, mtime: info.mtimeMs, size: info.size });
    }
  }
  const sessions: AgentSession[] = [];
  const selected = files.sort((a, b) => b.mtime - a.mtime).slice(0, MAX_SESSIONS);
  const touched = new Set(selected.map((f) => f.path));
  for (const cached of fileCache.keys()) if (!touched.has(cached)) fileCache.delete(cached);
  // Four full JSON parses at a time bounds extension-host memory even with large histories.
  for (let i = 0; i < selected.length; i += 4) {
    const batch = await Promise.all(selected.slice(i, i + 4).map(async (f) => {
      const hit = fileCache.get(f.path);
      if (hit && hit.size === f.size && hit.mtime === f.mtime && (!hit.value || hit.value.cwd === f.cwd)) return hit.value;
      const text = await boundedText(f.path);
      const value = text === undefined ? undefined : parseGeminiSession(text, f.cwd, f.path);
      if (value && value.updatedAt === undefined) value.updatedAt = f.mtime;
      fileCache.set(f.path, { size: f.size, mtime: f.mtime, value });
      return value;
    }));
    for (const s of batch) if (s) sessions.push({ ...s });
  }
  return sessions;
}

async function readOpenCode(command: string, now: number): Promise<AgentSession[]> {
  const cached = listCache.get(command);
  if (cached && cached.until > now) return cached.sessions.map((s) => ({ ...s }));
  const result = await run(command, ['session', 'list', '--max-count', '100', '--format', 'json', '--pure'], { timeoutMs: 5000 });
  const sessions = result.ok ? parseOpenCodeSessions(result.stdout) : [];
  listCache.set(command, { until: now + 60_000, sessions });
  return sessions.map((s) => ({ ...s }));
}

export async function readOtherAgents(opts: ReadOtherAgentsOptions): Promise<AgentSession[]> {
  const [gemini, opencode] = await Promise.all([readGemini(opts), readOpenCode(opts.opencodeCommand ?? 'opencode', opts.now)]);
  const sessions = [...gemini, ...opencode].filter((s) => s.updatedAt !== undefined && s.updatedAt >= opts.now - opts.endedSessionDays * DAY);
  const keys = new Map<string, Promise<string>>();
  for (const s of sessions) {
    if (!keys.has(s.cwd)) keys.set(s.cwd, opts.resolveProjectKey ? opts.resolveProjectKey(s.cwd).catch(() => s.cwd) : Promise.resolve(s.cwd));
    s.projectKey = await keys.get(s.cwd)!;
  }
  // One session may have both legacy JSON and migrated JSONL records.
  return [...new Map(sessions.sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0)).map((s) => [s.sessionId, s])).values()];
}
