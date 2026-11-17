// Codex adapter. Saved JSONL is read with bounded head/tail reads; runtime state comes only from an
// already-running app server. A transcript being recent is never evidence of a live agent.
import { connect } from 'node:net';
import WebSocket from 'ws';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ClaudeSession, SessionStatus } from '../model';

type Json = Record<string, unknown>;
const obj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => typeof v === 'string' && v.length > 0 ? v : undefined;
const time = (v: unknown): number | undefined => {
  if (typeof v === 'number' && Number.isFinite(v)) return v < 1e12 ? v * 1000 : v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
const cut = (s: string, n: number): string => s.length > n ? `${s.slice(0, n - 1)}…` : s;
const DAY = 86_400_000;
// session_meta includes base instructions, which can be substantially larger than the metadata itself.
const HEAD_BYTES = 1024 * 1024;
const TAIL_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 1000;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const transcriptCache = new Map<string, { at: number; size: number; value: Transcript | undefined }>();

export interface CodexRuntimeThread {
  id: string;
  cwd?: string;
  name?: string;
  preview?: string;
  path?: string;
  createdAt?: number;
  updatedAt?: number;
  gitInfo?: { branch?: string | null };
  status?: { type: string; activeFlags?: string[] };
}

export interface ReadCodexOptions {
  codexDir: string;
  endedSessionDays: number;
  now: number;
  resolveProjectKey?: (cwd: string) => Promise<string>;
  /** Test/integration seam. Undefined means the running daemon could not be queried. */
  runtimeThreads?: () => Promise<CodexRuntimeThread[] | undefined>;
}

interface Transcript {
  id: string;
  cwd?: string;
  name?: string;
  version?: string;
  branch?: string;
  startedAt?: number;
  updatedAt?: number;
  prompts: string[];
  report?: string;
  parent?: string;
}

function messageText(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (!Array.isArray(v)) return undefined;
  const text = v.filter(obj).filter((x) => x.type === 'input_text' || x.type === 'output_text' || x.type === 'text').map((x) => str(x.text) ?? '').join('\n');
  return text || undefined;
}

function promptText(v: unknown): string | undefined {
  const s = messageText(v)?.trim();
  if (!s || /^(?:# AGENTS\.md instructions|<environment_context>|<INSTRUCTIONS>|<permissions instructions>|<user_instructions>)/.test(s)) return undefined;
  return cut(s.replace(/\s+/g, ' '), 300);
}

/** Parse complete records only. The first session_meta owns a rollout: forked histories may repeat a parent's. */
export function parseCodexTranscript(text: string, expectedId?: string): Transcript | undefined {
  let out: Transcript | undefined;
  for (const line of text.split('\n')) {
    let r: unknown;
    try { r = JSON.parse(line); } catch { continue; }
    if (!obj(r) || !obj(r.payload)) continue;
    const p = r.payload;
    if (r.type === 'session_meta') {
      const id = str(p.id) ?? str(p.session_id);
      if (!id || (expectedId && id !== expectedId) || (out && out.id !== id)) continue;
      if (!out) out = { id, prompts: [] };
      out.cwd = str(p.cwd) ?? out.cwd;
      out.version = str(p.cli_version) ?? out.version;
      out.startedAt = time(p.timestamp) ?? out.startedAt;
      out.name = str(p.name) ?? str(p.agent_nickname) ?? out.name;
      out.parent = str(p.parent_thread_id) ?? out.parent;
      if (obj(p.git)) out.branch = str(p.git.branch) ?? out.branch;
      continue;
    }
    if (!out) continue;
    out.updatedAt = time(r.timestamp) ?? out.updatedAt;
    if (r.type === 'turn_context') {
      out.cwd = str(p.cwd) ?? out.cwd;
      if (obj(p.git)) out.branch = str(p.git.branch) ?? out.branch;
    }
    let prompt: string | undefined;
    let report: string | undefined;
    if (r.type === 'event_msg') {
      if (p.type === 'user_message') prompt = promptText(p.message);
      if (p.type === 'agent_message') report = messageText(p.message);
      if (p.type === 'task_complete') report = messageText(p.last_agent_message);
    }
    if (r.type === 'response_item' && p.type === 'message') {
      if (p.role === 'user') prompt = promptText(p.content);
      if (p.role === 'assistant' && p.phase !== 'analysis') report = messageText(p.content);
    }
    if (prompt && out.prompts[out.prompts.length - 1] !== prompt) out.prompts.push(prompt);
    if (report?.trim()) out.report = cut(report.trim(), 20_000);
  }
  if (out) out.prompts = out.prompts.slice(-5).reverse();
  return out;
}

async function boundedTranscript(path: string): Promise<Transcript | undefined> {
  const f = await open(path, 'r');
  try {
    const size = (await f.stat()).size;
    const head = Buffer.alloc(Math.min(size, HEAD_BYTES));
    const a = await f.read(head, 0, head.length, 0);
    let text = head.subarray(0, a.bytesRead).toString('utf8');
    if (size > HEAD_BYTES) {
      text = text.slice(0, text.lastIndexOf('\n') + 1);
      const start = Math.max(HEAD_BYTES, size - TAIL_BYTES);
      const tail = Buffer.alloc(size - start);
      const b = await f.read(tail, 0, tail.length, start);
      const decoded = tail.subarray(0, b.bytesRead).toString('utf8');
      text += decoded.slice(decoded.indexOf('\n') + 1);
    }
    // Codex appends a record as a whole line. A partial last record is never a reliable update.
    text = text.slice(0, text.lastIndexOf('\n') + 1);
    return parseCodexTranscript(text, basename(path).match(UUID)?.[0]);
  } finally { await f.close(); }
}

/** Read-only WebSocket connection to an existing local daemon. No server, thread or turn is started.
 *  Codex's `proxy` command relays raw bytes, including the WebSocket handshake, rather than JSONL. */
export async function readCodexRuntime(codexDir: string): Promise<CodexRuntimeThread[] | undefined> {
  const socket = join(codexDir, 'app-server-control', 'app-server-control.sock');
  if (!(await stat(socket).then((s) => s.isSocket(), () => false))) return undefined;
  return new Promise((resolve) => {
    const ws = new WebSocket('ws://localhost/', {
      createConnection: () => connect({ path: socket }), handshakeTimeout: 2500, maxPayload: 1024 * 1024,
    });
    const pending = new Map<number, (result: unknown) => void>();
    let id = 0;
    let finished = false;
    const finish = (threads: CodexRuntimeThread[] | undefined): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      for (const done of pending.values()) done(undefined);
      pending.clear();
      ws.terminate();
      resolve(threads);
    };
    const timer = setTimeout(() => finish(undefined), 3500);
    const request = (method: string, params: unknown = {}): Promise<unknown> => new Promise((done) => {
      if (finished) return done(undefined);
      const n = ++id;
      pending.set(n, done);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
    ws.on('error', () => finish(undefined));
    ws.on('close', () => finish(undefined));
    ws.on('message', (raw) => {
      let r: unknown;
      try { r = JSON.parse(raw.toString()); } catch { return; }
      if (!obj(r) || typeof r.id !== 'number') return;
      pending.get(r.id)?.(r.error ? undefined : r.result);
      pending.delete(r.id);
    });
    ws.on('open', () => {
      void (async () => {
        const hello = await request('initialize', { clientInfo: { name: 'cockpit', title: 'Cockpit', version: '0.3.3' } });
        if (!hello) return finish(undefined);
        ws.send(JSON.stringify({ method: 'initialized', params: {} }));
        const loaded = await request('thread/loaded/list');
        if (!obj(loaded) || !Array.isArray(loaded.data)) return finish(undefined);
        const ids = loaded.data.filter((x): x is string => typeof x === 'string').slice(0, 200);
        const result = await Promise.all(ids.map(async (threadId) => {
          const r = await request('thread/read', { threadId, includeTurns: false });
          return obj(r) && obj(r.thread) && typeof r.thread.id === 'string' ? r.thread as unknown as CodexRuntimeThread : undefined;
        }));
        finish(result.filter((x): x is CodexRuntimeThread => !!x));
      })().catch(() => finish(undefined));
    });
  });
}

export function codexRuntimeStatus(thread: CodexRuntimeThread | undefined): { live: boolean; status: SessionStatus; waitingFor?: string; statusNote?: string } {
  const state = thread?.status;
  if (!state) return { live: false, status: 'unknown', statusNote: 'Saved session; live state is unavailable. Open it in Codex to inspect.' };
  if (state.type === 'notLoaded') return { live: false, status: 'ended' };
  if (state.type === 'idle') return { live: true, status: 'idle' };
  if (state.type === 'active') {
    const flags = state.activeFlags ?? [];
    if (flags.includes('waitingOnApproval')) return { live: true, status: 'waiting', waitingFor: 'permission approval' };
    if (flags.includes('waitingOnUserInput')) return { live: true, status: 'waiting', waitingFor: 'your answer' };
    return { live: true, status: 'busy' };
  }
  return { live: true, status: 'unknown', statusNote: `Codex runtime: ${state.type}` };
}

/** Sessions are namespaced, so another provider may reuse the same native UUID without replacing Codex. */
export async function readCodex(opts: ReadCodexOptions): Promise<ClaudeSession[]> {
  const runtime = await (opts.runtimeThreads ?? (() => readCodexRuntime(opts.codexDir)))().catch(() => undefined);
  const live = new Map((runtime ?? []).map((t) => [t.id, t]));
  const cutoff = opts.now - Math.max(0, opts.endedSessionDays) * DAY;
  const paths: { path: string; at: number; size: number }[] = [];
  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 4) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) {
        const s = await stat(p).catch(() => undefined);
        const id = e.name.match(UUID)?.[0];
        if (s && (s.mtimeMs >= cutoff || (id && live.has(id)))) paths.push({ path: p, at: s.mtimeMs, size: s.size });
      }
    }
  }
  await walk(join(opts.codexDir, 'sessions'));
  const isLive = (path: string): boolean => live.has(basename(path).match(UUID)?.[0] ?? '');
  paths.sort((a, b) => Number(isLive(b.path)) - Number(isLive(a.path)) || b.at - a.at);
  const read = new Map<string, { transcript: Transcript; path: string; at: number }>();
  // Eight readers bound buffers and descriptors, independent of the number of saved sessions.
  const selected = paths.slice(0, MAX_FILES);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, selected.length) }, async () => {
    while (next < selected.length) {
      const file = selected[next++];
      if (!file) continue;
      const cached = transcriptCache.get(file.path);
      const transcript = cached && cached.at === file.at && cached.size === file.size
        ? cached.value : await boundedTranscript(file.path).catch(() => undefined);
      transcriptCache.set(file.path, { at: file.at, size: file.size, value: transcript });
      if (transcript && !read.has(transcript.id)) read.set(transcript.id, { transcript, ...file });
    }
  }));
  const touched = new Set(selected.map((f) => f.path));
  for (const p of transcriptCache.keys()) if (!touched.has(p)) transcriptCache.delete(p);
  const ids = new Set([...read.keys(), ...live.keys()]);
  const projects = new Map<string, Promise<string>>();
  return Promise.all([...ids].map(async (id): Promise<ClaudeSession> => {
    const file = read.get(id);
    const t = file?.transcript;
    const r = live.get(id);
    const cwd = r?.cwd ?? t?.cwd ?? '';
    if (!projects.has(cwd)) projects.set(cwd, cwd ? (opts.resolveProjectKey?.(cwd) ?? Promise.resolve(cwd)).catch(() => cwd) : Promise.resolve('(unknown folder)'));
    const prompts = t?.prompts ?? [];
    const s: ClaudeSession & { provider: string; nativeSessionId: string; agentVersion?: string; canResume: boolean; statusNote?: string } = {
      sessionId: `codex:${id}`, provider: 'codex', nativeSessionId: id, canResume: true,
      ...codexRuntimeStatus(r), title: r?.name ?? t?.name ?? prompts[0] ?? r?.preview ?? 'Codex session',
      name: r?.name ?? t?.name, cwd, projectKey: await projects.get(cwd)!, gitBranch: r?.gitInfo?.branch ?? t?.branch,
      lastPrompt: prompts[0] ?? r?.preview, recentPrompts: prompts,
      startedAt: time(r?.createdAt) ?? t?.startedAt, updatedAt: time(r?.updatedAt) ?? t?.updatedAt ?? file?.at,
      agentVersion: t?.version, transcriptPath: file?.path ?? r?.path, report: t?.report, subagents: [], workflows: [],
    };
    return s;
  }));
}
