// Claude Code adapter: live sessions, transcripts, subagents and workflow runs, read from Claude Code's local files
// under ~/.claude. These files are undocumented internals that change between versions, so every reader here
// ignores unknown fields, skips what it cannot parse, and never lets one broken session hide the others.
//
// What is on disk (Claude Code 2.1.3xx):
//   sessions/<pid>.json                               one per running process; can outlive it (check the pid)
//   projects/<slug>/<sessionId>.jsonl                 the transcript, append-only, up to hundreds of MB
//   projects/<slug>/<sessionId>/subagents/agent-<id>.meta.json (+ agent-<id>.jsonl)
//   projects/<slug>/<sessionId>/subagents/workflows/<runId>/agent-<id>.meta.json, journal.jsonl
//   projects/<slug>/<sessionId>/workflows/<runId>.json        written when a workflow run ends
//   projects/<slug>/<sessionId>/workflows/scripts/<name>-<runId>.js
import type { Stats } from 'node:fs';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { ClaudeSession, SessionStatus, Subagent, WorkflowPhase, WorkflowRun, WorkflowStatus } from '../model';
import { parseLstart, readProcessStarts } from '../procs';

export interface ReadClaudeOptions {
  /** Normally ~/.claude. */
  claudeDir: string;
  /** Ended sessions whose transcript was last written longer ago than this are left out. */
  endedSessionDays: number;
  now: number;
  isPidAlive?: (pid: number) => boolean;
  /** When each pid's process started (a pid missing from the map has no process), or undefined when that cannot
   *  be told. Default: ps. */
  processStarts?: (pids: number[]) => Promise<Map<number, number> | undefined>;
  /** Injected by the store (the git main checkout of cwd). Default: cwd itself. */
  resolveProjectKey?: (cwd: string) => Promise<string>;
}

/** The project key of a session whose folder is unknown (a transcript with no record carrying a cwd, in a project
 *  directory no other session's folder is named after). Not a path: nothing resolves or opens it. */
export const NO_FOLDER_KEY = '(unknown folder)';

const DAY_MS = 86_400_000;
/** Concurrent file operations (also bounds open file descriptors). */
const CONCURRENCY = 24;
/** Concurrent transcript scans: each holds a read buffer and the strings decoded from it, in an extension host
 *  shared with other extensions. */
const SCAN_CONCURRENCY = 8;
/** Tail reads go backwards in chunks of this size, through one buffer per scan. */
const CHUNK_BYTES = 1024 * 1024;
/** A pid file whose recorded start is this far from its process's real start belongs to an earlier process that
 *  had the same pid (ps prints whole seconds; Claude Code writes startedAt a moment after the process starts). */
const START_SLACK_MS = 30_000;
const MAX_PROMPTS = 5;
const PROMPT_CHARS = 300;
const HEAD_BYTES = 64 * 1024;
/** How far back from the end a transcript is read, chunk by chunk, until 5 prompts are found. Claude Code keeps
 *  re-appending its title and last-prompt records, so the newest ones always sit in the first chunk (measured: at
 *  most ~34 KB from the end); only older prompts need more. */
const TAIL_BYTES = 4 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_SCRIPT_BYTES = 64 * 1024;

// ───────────────────────────── Small helpers ─────────────────────────────

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isoTime = (v: unknown): number | undefined => {
  const s = str(v);
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : t;
};

type Gate = <T>(fn: () => Promise<T>) => Promise<T>;

/** Runs at most `limit` of the wrapped operations at once. Only leaf file operations go through it, so it cannot deadlock. */
function makeGate(limit: number): Gate {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < limit) active++;
    else await new Promise<void>((resolve) => queue.push(resolve)); // the finishing operation hands over its slot
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Parsed results keyed by path and invalidated by (size, mtime): readClaude runs again on every change.
interface Cached<T> {
  size: number;
  mtimeMs: number;
  value: T;
}
const fileCache = new Map<string, Cached<unknown>>();
const transcriptCache = new Map<string, TranscriptEntry>();
let touched = new Set<string>();

/** Forgets everything parsed so far (for tests). */
export function resetClaudeCache(): void {
  fileCache.clear();
  transcriptCache.clear();
}

/** Reads and parses a file once per (size, mtime). Returns undefined when it is missing or unreadable. */
async function cachedFile<T>(gate: Gate, path: string, parse: (text: string) => T, maxBytes = Infinity): Promise<T | undefined> {
  try {
    const st = await gate(() => stat(path));
    touched.add(path);
    const hit = fileCache.get(path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.value as T;
    if (st.size > maxBytes) return undefined;
    const value = parse(await gate(() => readFile(path, 'utf8')));
    fileCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, value });
    return value;
  } catch {
    return undefined;
  }
}

async function listDir(gate: Gate, dir: string) {
  try {
    return await gate(() => readdir(dir, { withFileTypes: true }));
  } catch {
    return [];
  }
}

async function statOrUndefined(gate: Gate, path: string): Promise<Stats | undefined> {
  try {
    return await gate(() => stat(path));
  } catch {
    return undefined;
  }
}

// ───────────────────────────── Live process files ─────────────────────────────

interface LiveFile {
  pid: number;
  sessionId: string;
  cwd?: string;
  name?: string;
  status?: string;
  waitingFor?: string;
  startedAt?: number;
  updatedAt?: number;
  /** procStart: the process's start as ps printed it, in UTC. */
  procStartAt?: number;
  version?: string;
}

export function parseLiveFile(text: string): LiveFile | undefined {
  const o = parseJson(text);
  if (!isObj(o)) return undefined;
  const pid = num(o.pid);
  const sessionId = str(o.sessionId);
  if (pid === undefined || !sessionId) return undefined;
  return {
    pid,
    sessionId,
    cwd: str(o.cwd),
    name: str(o.name),
    status: str(o.status),
    waitingFor: str(o.waitingFor),
    startedAt: num(o.startedAt),
    updatedAt: num(o.updatedAt),
    procStartAt: typeof o.procStart === 'string' ? parseLstart(o.procStart) : undefined,
    version: str(o.version),
  };
}

/** The pid file was written by the process that has its pid now, as far as start times tell. A pid file outlives a
 *  crash or a reboot, and its pid is soon reused by an unrelated process that started later. */
export function sameProcess(f: LiveFile, realStart: number | undefined): boolean {
  if (realStart === undefined) return false;
  if (f.procStartAt !== undefined) return Math.abs(f.procStartAt - realStart) <= START_SLACK_MS;
  // Without procStart: a file whose process started before the running one cannot be the running one's.
  const recorded = f.startedAt ?? f.updatedAt;
  return recorded === undefined || recorded >= realStart - START_SLACK_MS;
}

async function readLiveFiles(gate: Gate, dir: string): Promise<LiveFile[]> {
  const names = (await listDir(gate, dir)).filter((e) => e.isFile() && /^\d+\.json$/.test(e.name)).map((e) => e.name);
  const files = await Promise.all(names.map((n) => cachedFile(gate, join(dir, n), parseLiveFile)));
  return files.filter((f): f is LiveFile => f !== undefined);
}

const LIVE_STATUSES: Record<string, SessionStatus> = { busy: 'busy', idle: 'idle', waiting: 'waiting' };

// ───────────────────────────── Transcripts ─────────────────────────────

interface TranscriptFile {
  sessionId: string;
  path: string;
  /** The project directory (projects/<slug>) holding it. */
  dir: string;
  size: number;
  mtimeMs: number;
}

interface TranscriptInfo {
  customTitle?: string;
  aiTitle?: string;
  agentName?: string;
  lastPrompt?: string;
  /** Newest first. */
  prompts: string[];
  cwd?: string;
  gitBranch?: string;
  version?: string;
  firstAt?: number;
  /** The newest record carrying cwd was seen: cwd, gitBranch and version are settled. */
  sawRecord: boolean;
}

interface TranscriptEntry {
  size: number;
  mtimeMs: number;
  /** End of the last complete line read: where an append-only read resumes. */
  scannedTo: number;
  info: TranscriptInfo;
}

const emptyInfo = (): TranscriptInfo => ({ prompts: [], sawRecord: false });

const META_TYPES = new Set(['custom-title', 'ai-title', 'agent-name', 'last-prompt', 'relocated']);
const HUMAN_MARK = '"origin":{"kind":"human"';

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

/** Turns what the person typed into one display line, or undefined when it is not something a person typed. */
export function cleanPrompt(raw: string, fromHuman: boolean): string | undefined {
  let s = raw.trim();
  // Without an origin marker (older Claude Code), wrappers are the only way to tell machine text from typing.
  if (!fromHuman && (s.startsWith('<') || s.startsWith('[Request interrupted') || /^\/\S+$/.test(s))) return undefined;
  if (/^<(command-name|command-message|local-command-|bash-|task-notification)/.test(s)) return undefined;
  s = s
    .replace(/<system-reminder>[\s\S]*?(<\/system-reminder>|$)/g, ' ')
    .replace(/<pasted_content\b[^>]*>[\s\S]*?(<\/pasted_content>|$)/g, ' [pasted text] ')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? cut(s, PROMPT_CHARS) : undefined;
}

function promptOf(rec: Json): string | undefined {
  if (rec.type !== 'user' || rec.isMeta === true || rec.isSidechain === true || rec.isCompactSummary === true) return undefined;
  if (rec.toolUseResult !== undefined) return undefined;
  const origin = rec.origin;
  if (origin !== undefined && !(isObj(origin) && origin.kind === 'human')) return undefined;
  const message = rec.message;
  if (!isObj(message)) return undefined;
  const content = message.content;
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    if (content.some((c) => isObj(c) && c.type === 'tool_result')) return undefined;
    text = content
      .filter((c): c is Json => isObj(c) && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
  }
  return text ? cleanPrompt(text, origin !== undefined) : undefined;
}

/** Folds one transcript line into `acc`. Lines arrive newest first, so the first value seen for a field wins.
 *  Only lines that can matter are parsed: most of a transcript is tool output. */
function takeLine(line: string, acc: TranscriptInfo, wantPrompts: boolean): void {
  if (line.length === 0) return;
  const metaType = /^\{"type":"([a-z-]+)"/.exec(line)?.[1];
  if (metaType && META_TYPES.has(metaType)) {
    const o = parseJson(line);
    if (!isObj(o)) return;
    if (metaType === 'custom-title') acc.customTitle ??= str(o.customTitle);
    else if (metaType === 'ai-title') acc.aiTitle ??= str(o.aiTitle);
    else if (metaType === 'agent-name') acc.agentName ??= str(o.agentName);
    else if (metaType === 'last-prompt') acc.lastPrompt ??= str(o.lastPrompt);
    else if (!acc.sawRecord) acc.cwd ??= str(o.relocatedCwd);
    return;
  }
  const wantRecord = !acc.sawRecord && line.includes('"cwd":"');
  const promptCandidate =
    wantPrompts &&
    acc.prompts.length < MAX_PROMPTS &&
    (line.includes(HUMAN_MARK) || (!line.includes('"origin":') && line.includes('"type":"user"') && !line.includes('"tool_use_id"')));
  if (!wantRecord && !promptCandidate) return;
  const rec = parseJson(line);
  if (!isObj(rec)) return;
  if (wantRecord && str(rec.cwd)) {
    acc.sawRecord = true;
    acc.cwd ??= str(rec.cwd);
    acc.gitBranch ??= str(rec.gitBranch);
    acc.version ??= str(rec.version);
  }
  if (promptCandidate) {
    const p = promptOf(rec);
    // The same text shows up again when a prompt is resent or a conversation is rewound: list it once.
    if (p && !acc.prompts.includes(p)) acc.prompts.push(p);
  }
}

type FileHandle = Awaited<ReturnType<typeof open>>;

/** Feeds the complete lines of [from, to) to `take`, newest first, reading backwards chunk by chunk through one
 *  buffer, at most TAIL_BYTES, and stopping between chunks once `enough()`. A line still being written (after the
 *  last newline) is skipped, and so is the line cut by where reading stopped. */
async function scanBackwards(
  fh: FileHandle,
  from: number,
  to: number,
  take: (line: string) => void,
  enough: () => boolean,
): Promise<{ end: number; reachedFrom: boolean; lowest: number }> {
  const floor = Math.max(from, to - TAIL_BYTES);
  const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, to - floor));
  let pos = to;
  // The start of the oldest line seen so far, whose beginning lies in the next (older) chunk.
  let carry: Buffer | undefined;
  let end = -1;
  while (pos > floor) {
    const start = Math.max(floor, pos - buf.length);
    const { bytesRead } = await fh.read(buf, 0, pos - start, start);
    const chunk = buf.subarray(0, bytesRead);
    const data = carry ? Buffer.concat([chunk, carry]) : chunk;
    let j = data.length;
    if (end < 0) {
      const nl = data.lastIndexOf(10);
      if (nl >= 0) {
        end = start + nl + 1;
        j = nl;
      } else j = 0; // all of it belongs to the unfinished last line
    }
    while (j > 0) {
      const nl = data.lastIndexOf(10, j - 1);
      if (nl < 0) break;
      take(data.toString('utf8', nl + 1, j));
      j = nl;
    }
    pos = start;
    if (start === from) {
      if (j > 0 && end >= 0) take(data.toString('utf8', 0, j));
      return { end: end < 0 ? from : end, reachedFrom: true, lowest: from };
    }
    // A copy: `buf` is overwritten by the next read.
    carry = j > 0 ? Buffer.from(data.subarray(0, j)) : undefined;
    if (enough()) break;
  }
  return { end: end < 0 ? from : end, reachedFrom: false, lowest: pos };
}

/** Feeds the head's complete lines to `take` newest first, and returns the first record's timestamp. */
async function scanHead(fh: FileHandle, limit: number, take: ((line: string) => void) | undefined): Promise<number | undefined> {
  const len = Math.min(HEAD_BYTES, limit);
  if (len <= 0) return undefined;
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, 0);
  const text = buf.toString('utf8', 0, bytesRead);
  const lines = text.split('\n');
  lines.pop(); // complete only when a newline follows it
  let firstAt: number | undefined;
  for (const line of lines) {
    if (!line.includes('"timestamp":"')) continue;
    const o = parseJson(line);
    firstAt = isObj(o) ? isoTime(o.timestamp) : undefined;
    if (firstAt !== undefined) break;
  }
  if (take) for (let i = lines.length - 1; i >= 0; i--) take(lines[i] as string);
  return firstAt;
}

async function scanTranscript(path: string, from: number, size: number, withHead: boolean): Promise<{ info: TranscriptInfo; end: number }> {
  const info = emptyInfo();
  const fh = await open(path, 'r');
  try {
    const tail = await scanBackwards(
      fh,
      from,
      size,
      (line) => takeLine(line, info, true),
      () => info.prompts.length >= MAX_PROMPTS,
    );
    if (withHead) {
      // Prompts in the head are skipped unless the tail reached it: a gap would make them look recent.
      const fill = tail.reachedFrom ? undefined : (line: string) => takeLine(line, info, false);
      info.firstAt = await scanHead(fh, tail.reachedFrom ? size : tail.lowest, fill);
    }
    return { info, end: tail.end };
  } finally {
    await fh.close();
  }
}

/** `newer` was read from bytes appended after `older`'s. */
function mergeInfo(newer: TranscriptInfo, older: TranscriptInfo): TranscriptInfo {
  return {
    customTitle: newer.customTitle ?? older.customTitle,
    aiTitle: newer.aiTitle ?? older.aiTitle,
    agentName: newer.agentName ?? older.agentName,
    lastPrompt: newer.lastPrompt ?? older.lastPrompt,
    prompts: [...new Set([...newer.prompts, ...older.prompts])].slice(0, MAX_PROMPTS),
    cwd: newer.cwd ?? older.cwd,
    gitBranch: newer.sawRecord ? newer.gitBranch : older.gitBranch,
    version: newer.version ?? older.version,
    firstAt: older.firstAt ?? newer.firstAt,
    sawRecord: newer.sawRecord || older.sawRecord,
  };
}

async function readTranscript(gate: Gate, scanGate: Gate, t: TranscriptFile): Promise<TranscriptInfo> {
  touched.add(t.path);
  const hit = transcriptCache.get(t.path);
  if (hit && hit.size === t.size && hit.mtimeMs === t.mtimeMs) return hit.info;
  let entry: TranscriptEntry;
  if (hit && t.size > hit.size) {
    // Transcripts are append-only: read only what was added since the last complete line.
    const delta = await scanGate(() => gate(() => scanTranscript(t.path, hit.scannedTo, t.size, false)));
    entry = { size: t.size, mtimeMs: t.mtimeMs, scannedTo: delta.end, info: mergeInfo(delta.info, hit.info) };
  } else {
    const full = await scanGate(() => gate(() => scanTranscript(t.path, 0, t.size, true)));
    entry = { size: t.size, mtimeMs: t.mtimeMs, scannedTo: full.end, info: full.info };
  }
  transcriptCache.set(t.path, entry);
  return entry.info;
}

async function listTranscripts(gate: Gate, projectsDir: string): Promise<Map<string, TranscriptFile>> {
  const dirs = (await listDir(gate, projectsDir)).filter((e) => e.isDirectory()).map((e) => join(projectsDir, e.name));
  const perDir = await Promise.all(
    dirs.map(async (dir) => {
      const names = (await listDir(gate, dir)).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
      return Promise.all(
        names.map(async (name): Promise<TranscriptFile | undefined> => {
          const st = await statOrUndefined(gate, join(dir, name));
          return st && { sessionId: name.slice(0, -'.jsonl'.length), path: join(dir, name), dir, size: st.size, mtimeMs: st.mtimeMs };
        }),
      );
    }),
  );
  const out = new Map<string, TranscriptFile>();
  for (const t of perDir.flat()) {
    if (!t) continue;
    const prev = out.get(t.sessionId);
    if (!prev || t.mtimeMs > prev.mtimeMs) out.set(t.sessionId, t);
  }
  return out;
}

// ───────────────────────────── Subagents ─────────────────────────────

interface AgentMeta {
  description?: string;
  agentType?: string;
  model?: string;
  finished: boolean;
}

export function parseAgentMeta(text: string): AgentMeta | undefined {
  const o = parseJson(text);
  if (!isObj(o)) return undefined;
  // An agent the person stopped is marked stoppedByUser and never gets finished.
  return { description: str(o.description), agentType: str(o.agentType), model: str(o.model), finished: o.finished === true || o.stoppedByUser === true };
}

const AGENT_META = /^agent-(.+)\.meta\.json$/;

async function readAgentsIn(gate: Gate, dir: string, workflowRunId?: string): Promise<Subagent[]> {
  const ids = (await listDir(gate, dir)).flatMap((e) => (e.isFile() ? (AGENT_META.exec(e.name)?.[1] ?? []) : []));
  const agents = await Promise.all(
    ids.map(async (id): Promise<Subagent | undefined> => {
      const [meta, transcript] = await Promise.all([
        cachedFile(gate, join(dir, `agent-${id}.meta.json`), parseAgentMeta),
        statOrUndefined(gate, join(dir, `agent-${id}.jsonl`)),
      ]);
      if (!meta) return undefined;
      return {
        id,
        description: meta.description ?? '',
        agentType: meta.agentType ?? 'unknown',
        model: meta.model,
        finished: meta.finished,
        workflowRunId,
        updatedAt: transcript && Math.floor(transcript.mtimeMs),
      };
    }),
  );
  return agents.filter((a) => a !== undefined);
}

// ───────────────────────────── Workflows ─────────────────────────────

interface WorkflowFile {
  run: WorkflowRun;
}

function mapWorkflowStatus(s: string | undefined): WorkflowStatus {
  if (s === 'completed' || s === 'running') return s;
  if (s === 'failed' || s === 'killed' || s === 'error' || s === 'cancelled' || s === 'canceled' || s === 'stopped') return 'failed';
  return 'unknown';
}

/** done before `current`, pending after it; every phase done when the run completed. */
function phaseStates(phases: WorkflowPhase[], current: number | undefined, allDone: boolean): WorkflowPhase[] {
  if (allDone) return phases.map((p) => ({ ...p, state: 'done' }));
  if (current === undefined || current < 0) return phases;
  return phases.map((p, i) => ({ ...p, state: i < current ? 'done' : i === current ? 'current' : 'pending' }));
}

function parsePhases(v: unknown): WorkflowPhase[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((p) => (isObj(p) && str(p.title) ? [{ title: p.title as string, detail: str(p.detail) }] : []));
}

export function parseWorkflowFile(text: string, fallbackRunId: string): WorkflowFile | undefined {
  const o = parseJson(text);
  if (!isObj(o)) return undefined;
  const status = mapWorkflowStatus(str(o.status));
  // The furthest phase any agent reached is where an unfinished run stopped (1-based in the file).
  let reached: number | undefined;
  if (Array.isArray(o.workflowProgress)) {
    for (const p of o.workflowProgress) {
      const idx = isObj(p) && p.type === 'workflow_agent' ? num(p.phaseIndex) : undefined;
      if (idx !== undefined) reached = Math.max(reached ?? 0, idx);
    }
  }
  return {
    run: {
      runId: str(o.runId) ?? fallbackRunId,
      name: str(o.workflowName),
      summary: str(o.summary),
      status,
      phases: phaseStates(parsePhases(o.phases), reached === undefined ? undefined : reached - 1, status === 'completed'),
      agentCount: num(o.agentCount),
      startedAt: num(o.startTime) ?? isoTime(o.timestamp),
      durationMs: num(o.durationMs),
    },
  };
}

interface Journal {
  /** Phase titles of started agents, in start order. */
  startedPhases: string[];
  /** Agents that returned a result or failed. */
  done: Set<string>;
}

export function parseJournal(text: string): Journal {
  const journal: Journal = { startedPhases: [], done: new Set() };
  for (const line of text.split('\n')) {
    const o = parseJson(line);
    if (!isObj(o)) continue;
    const agentId = str(o.agentId);
    if (o.type === 'started') {
      const phase = str(o.phase);
      if (phase) journal.startedPhases.push(phase);
    } else if ((o.type === 'result' || o.type === 'failed') && agentId) journal.done.add(agentId);
  }
  return journal;
}

interface ScriptMeta {
  name?: string;
  description?: string;
  phases: WorkflowPhase[];
}

const STRING_LIT = String.raw`(['"\x60])((?:\\.|(?!\1)[^\\])*)\1`;
const PHASE_ENTRY = new RegExp(String.raw`\{\s*title\s*:\s*${STRING_LIT}(?:\s*,\s*detail\s*:\s*(['"\x60])((?:\\.|(?!\3)[^\\])*)\3)?`, 'g');

/** Reads `export const meta = { name, description, phases: [{ title, detail }] }` from a workflow script by
 *  pattern: the script is never evaluated. */
export function parseScriptMeta(text: string): ScriptMeta {
  const at = text.search(/\bmeta\s*=\s*\{/);
  if (at < 0) return { phases: [] };
  const close = text.indexOf('\n}', at); // the object ends at the first unindented brace
  const meta = text.slice(at, close < 0 ? undefined : close);
  const phasesAt = meta.search(/\bphases\s*:\s*\[/);
  const phasesEnd = phasesAt < 0 ? -1 : meta.indexOf(']', phasesAt);
  const phasesSrc = phasesAt < 0 ? '' : meta.slice(phasesAt, phasesEnd < 0 ? undefined : phasesEnd);
  // name and description are looked up outside the phases list, whose entries have their own fields.
  const outside = phasesAt < 0 ? meta : meta.slice(0, phasesAt) + (phasesEnd < 0 ? '' : meta.slice(phasesEnd));
  const field = (key: string) => new RegExp(String.raw`\b${key}\s*:\s*${STRING_LIT}`).exec(outside)?.[2];
  const phases = [...phasesSrc.matchAll(PHASE_ENTRY)].map((m) => ({ title: m[2] ?? '', detail: m[4] }));
  return { name: field('name'), description: field('description'), phases };
}

async function readScriptMeta(gate: Gate, scriptsDir: string, runId: string): Promise<ScriptMeta & { fileName?: string }> {
  const file = (await listDir(gate, scriptsDir)).find((e) => e.isFile() && e.name.endsWith(`-${runId}.js`));
  if (!file) return { phases: [] };
  const fileName = file.name.slice(0, -`-${runId}.js`.length);
  const meta = await cachedFile(gate, join(scriptsDir, file.name), (t) => parseScriptMeta(t.slice(0, MAX_SCRIPT_BYTES)), 4 * 1024 * 1024);
  return { ...(meta ?? { phases: [] }), fileName };
}

/** A run with no <runId>.json yet: it is written when the run ends. */
async function readUnfinishedRun(gate: Gate, sessionDir: string, runId: string, running: boolean, journal: Journal | undefined, agentCount: number, startedAt: number | undefined): Promise<WorkflowRun> {
  const script = await readScriptMeta(gate, join(sessionDir, 'workflows', 'scripts'), runId);
  const lastPhase = journal?.startedPhases.at(-1);
  const current = lastPhase === undefined ? undefined : script.phases.findIndex((p) => p.title === lastPhase);
  return {
    runId,
    name: script.name ?? script.fileName,
    summary: script.description,
    status: running ? 'running' : 'unknown',
    phases: running ? phaseStates(script.phases, current, false) : script.phases,
    agentCount: agentCount || undefined,
    startedAt,
  };
}

/** Subagents and workflow runs of one session. `liveSince` is when its live process started (undefined: ended). */
async function readSessionDir(gate: Gate, sessionDir: string, liveSince: number | undefined): Promise<{ subagents: Subagent[]; workflows: WorkflowRun[] }> {
  const live = liveSince !== undefined;
  const subDir = join(sessionDir, 'subagents');
  const wfRunsDir = join(subDir, 'workflows');
  const [direct, runDirs, wfFiles] = await Promise.all([
    readAgentsIn(gate, subDir),
    listDir(gate, wfRunsDir).then((es) => new Set(es.filter((e) => e.isDirectory()).map((e) => e.name))),
    listDir(gate, join(sessionDir, 'workflows')).then(
      (es) => new Set(es.filter((e) => e.isFile() && /^wf_.+\.json$/.test(e.name)).map((e) => e.name.slice(0, -'.json'.length))),
    ),
  ]);
  const perRun = await Promise.all(
    [...new Set([...wfFiles, ...runDirs])].map(async (runId) => {
      const runDir = join(wfRunsDir, runId);
      const [file, agents, journalStat] = await Promise.all([
        wfFiles.has(runId) ? cachedFile(gate, join(sessionDir, 'workflows', `${runId}.json`), (t) => parseWorkflowFile(t, runId)) : undefined,
        runDirs.has(runId) ? readAgentsIn(gate, runDir, runId) : [],
        runDirs.has(runId) ? statOrUndefined(gate, join(runDir, 'journal.jsonl')) : undefined,
      ]);
      // Without its <runId>.json a run is still going only if the live process touched it: a run left behind by an
      // earlier process of a resumed session never finishes.
      const lastTouch = Math.max(journalStat?.mtimeMs ?? 0, ...agents.map((a) => a.updatedAt ?? 0));
      const running = file ? file.run.status === 'running' && live : live && lastTouch >= liveSince;
      // Workflow agents' meta files never say "finished": the run's journal does, once an agent has a result.
      const journal = running ? await cachedFile(gate, join(runDir, 'journal.jsonl'), parseJournal, MAX_JOURNAL_BYTES) : undefined;
      const born = journalStat && Math.floor(journalStat.birthtimeMs > 0 ? journalStat.birthtimeMs : journalStat.ctimeMs);
      const run = file
        ? { ...file.run, status: file.run.status === 'running' && !live ? 'unknown' : file.run.status }
        : await readUnfinishedRun(gate, sessionDir, runId, running, journal, agents.length, born);
      const settled = agents.map((a) => ({ ...a, finished: a.finished || !running || (journal?.done.has(a.id) ?? false) }));
      return { run, agents: settled };
    }),
  );
  // A subagent cannot outlive its session's process, and one whose transcript the live process never touched was
  // left behind by an earlier process of a resumed session (killed with it, so never marked finished).
  const leftBehind = (a: Subagent) => !live || (a.updatedAt !== undefined && a.updatedAt < liveSince);
  const subagents = [...direct.map((a) => ({ ...a, finished: a.finished || leftBehind(a) })), ...perRun.flatMap((r) => r.agents)].sort(
    (a, b) => Number(a.finished) - Number(b.finished) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  const workflows = perRun
    .map((r) => r.run)
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return { subagents, workflows };
}

// ───────────────────────────── Sessions ─────────────────────────────

/** The name Claude Code gives a folder's directory under projects/: every character but ASCII letters and digits
 *  becomes "-" ("/work/demo/.claude" → "-work-demo--claude"). */
export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

/** A title from a prompt: up to 60 characters, cut at a word. */
function firstWords(s: string): string {
  if (s.length <= 60) return s;
  const space = s.lastIndexOf(' ', 59);
  return `${s.slice(0, space > 20 ? space : 59).trimEnd()}…`;
}

async function buildSession(gate: Gate, scanGate: Gate, id: string, live: LiveFile | undefined, transcript: TranscriptFile | undefined): Promise<Omit<ClaudeSession, 'projectKey'>> {
  const info = transcript ? await readTranscript(gate, scanGate, transcript).catch(emptyInfo) : emptyInfo();
  const none = { subagents: [], workflows: [] };
  const { subagents, workflows } = transcript
    ? await readSessionDir(gate, join(transcript.dir, id), live ? (live.startedAt ?? 0) : undefined).catch(() => none)
    : none;
  const name = live?.name ?? info.agentName;
  const lastPrompt = (info.lastPrompt && cleanPrompt(info.lastPrompt, true)) ?? info.prompts[0];
  const status: SessionStatus = live ? (LIVE_STATUSES[live.status ?? ''] ?? 'unknown') : 'ended';
  // A busy session writes its transcript continuously while the status file only changes on transitions.
  const activity = [live?.updatedAt, transcript?.mtimeMs].filter((t): t is number => t !== undefined);
  return {
    sessionId: id,
    live: live !== undefined,
    pid: live?.pid,
    status,
    waitingFor: status === 'waiting' ? live?.waitingFor : undefined,
    title: info.customTitle ?? info.aiTitle ?? name ?? (lastPrompt ? firstWords(lastPrompt) : `Session ${id.slice(0, 8)}`),
    name,
    cwd: live?.cwd ?? info.cwd ?? '',
    gitBranch: info.gitBranch,
    lastPrompt,
    // A big transcript can hold its prompts further back than the tail read reaches; the last one is always known.
    recentPrompts: info.prompts.length === 0 && lastPrompt ? [lastPrompt] : info.prompts,
    startedAt: live?.startedAt ?? info.firstAt,
    updatedAt: activity.length ? Math.floor(Math.max(...activity)) : undefined,
    claudeVersion: live?.version ?? info.version,
    transcriptPath: transcript?.path,
    subagents,
    workflows,
  };
}

/** Every live Claude Code session, plus the ended ones active within `endedSessionDays`: live first, then newest. */
export async function readClaude(opts: ReadClaudeOptions): Promise<ClaudeSession[]> {
  const gate = makeGate(CONCURRENCY);
  const scanGate = makeGate(SCAN_CONCURRENCY);
  const isAlive = opts.isPidAlive ?? defaultPidAlive;
  const processStarts = opts.processStarts ?? readProcessStarts;
  const resolveKey = opts.resolveProjectKey ?? (async (cwd: string) => cwd);
  touched = new Set();

  const [liveFiles, transcripts] = await Promise.all([
    readLiveFiles(gate, join(opts.claudeDir, 'sessions')),
    listTranscripts(gate, join(opts.claudeDir, 'projects')),
  ]);

  const alive = liveFiles.filter((f) => isAlive(f.pid));
  const starts = await processStarts([...new Set(alive.map((f) => f.pid))]).catch(() => undefined);
  const live = new Map<string, LiveFile>();
  for (const f of alive) {
    // Without start times (no ps) the pid check is all there is.
    if (starts && !sameProcess(f, starts.get(f.pid))) continue;
    const prev = live.get(f.sessionId);
    if (!prev || (f.updatedAt ?? 0) > (prev.updatedAt ?? 0)) live.set(f.sessionId, f);
  }

  const cutoff = opts.now - opts.endedSessionDays * DAY_MS;
  const ids = new Set(live.keys());
  for (const t of transcripts.values()) if (t.size > 0 && t.mtimeMs >= cutoff) ids.add(t.sessionId);

  const built = await Promise.all(
    [...ids].map((id) => buildSession(gate, scanGate, id, live.get(id), transcripts.get(id)).catch(() => undefined)),
  );
  const sessions = built.filter((s) => s !== undefined);

  // Claude Code names a project directory after the folder the session started in, so a session with no cwd of its
  // own (a transcript with no record carrying one) is in the folder whose name gives that directory's name, when
  // another session shows it. (Not simply its neighbours' cwd: a record's cwd follows the session's `cd`s.) An
  // empty cwd is never resolved: git would read it as the extension host's own working directory.
  const bySlug = new Map<string, string>();
  for (const s of sessions) if (s.cwd) bySlug.set(projectSlug(s.cwd), s.cwd);
  const keys = new Map<string, Promise<string>>();
  const keyOf = (cwd: string) => {
    let k = keys.get(cwd);
    if (!k) {
      k = resolveKey(cwd).catch(() => cwd);
      keys.set(cwd, k);
    }
    return k;
  };
  const out: ClaudeSession[] = await Promise.all(
    sessions.map(async (s) => {
      const dir = transcripts.get(s.sessionId)?.dir;
      const folder = s.cwd || (dir ? bySlug.get(basename(dir)) : undefined);
      return { ...s, projectKey: folder ? await keyOf(folder) : NO_FOLDER_KEY };
    }),
  );

  // Forget files that are gone or fell out of the window.
  for (const k of fileCache.keys()) if (!touched.has(k)) fileCache.delete(k);
  for (const k of transcriptCache.keys()) if (!touched.has(k)) transcriptCache.delete(k);

  return out.sort((a, b) => Number(b.live) - Number(a.live) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}
