// `.cockpit/` at the top of the main checkout: where Cockpit keeps its own files (the board, its config, the
// requests of the `cockpit` command). Node only, no `vscode`.
//
// .cockpit/config.json, every key optional (a missing or unreadable file is the defaults):
//   { "delivery": "auto" | "direct" | "pr",      how finished work reaches the default branch (default "auto")
//     "roadmap": "docs/ROADMAP.md" }             the board's file, from the repository's root
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Delivery } from '../model';

export const COCKPIT_DIR = '.cockpit';
export const CONFIG_FILE = `${COCKPIT_DIR}/config.json`;
/** Where the board is kept when nothing says otherwise. */
export const BOARD_FILE = `${COCKPIT_DIR}/roadmap.md`;
/** The board of projects from before 0.3.0, still used when it is there. */
export const LEGACY_BOARD_FILE = 'ROADMAP.md';

export type DeliverySetting = 'auto' | Delivery;

export interface CockpitConfig {
  delivery: DeliverySetting;
  /** The board's file from the repository's root, forward slashes, checked to stay inside it. */
  roadmap?: string;
}

/** Makes `<root>/.cockpit/`, with a `.gitignore` that keeps everything in it out of git. The `.gitignore` is
 *  written only when missing: relaxing it (to share the board) is the person's choice, and stays. Returns the folder. */
export async function ensureCockpitDir(root: string): Promise<string> {
  const dir = join(root, COCKPIT_DIR);
  await mkdir(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) await writeFile(ignore, '*\n', { encoding: 'utf8', flag: 'wx' }).catch(() => undefined);
  return dir;
}

/** A path from the repository's root that stays inside it: relative, no ".." step, no empty name. */
export function repoPath(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const p = raw.trim().replace(/\\/g, '/');
  if (!p || isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith('/')) return undefined;
  const parts = p.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0 || parts.some((s) => s === '..')) return undefined;
  return parts.join('/');
}

/** The config as `.cockpit/config.json` holds it: anything it does not understand is left at the default. */
export function parseConfig(text: string | undefined): CockpitConfig {
  const config: CockpitConfig = { delivery: 'auto' };
  if (text === undefined) return config;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return config;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return config;
  const o = raw as Record<string, unknown>;
  if (o.delivery === 'auto' || o.delivery === 'direct' || o.delivery === 'pr') config.delivery = o.delivery;
  const roadmap = repoPath(o.roadmap);
  if (roadmap) config.roadmap = roadmap;
  return config;
}

export async function readConfig(root: string): Promise<CockpitConfig> {
  return parseConfig(await readFile(join(root, CONFIG_FILE), 'utf8').catch(() => undefined));
}

/** Which file is the board, first match: the config's "roadmap"; `.cockpit/roadmap.md` when it exists; `ROADMAP.md`
 *  at the root when it exists; else `.cockpit/roadmap.md`, where a new board is created. `name` is the path from
 *  the root, for display. */
export function resolveRoadmap(root: string, config: CockpitConfig, exists: (path: string) => boolean): { path: string; name: string } {
  const at = (name: string) => ({ path: join(root, ...name.split('/')), name });
  if (config.roadmap) return at(config.roadmap);
  const board = at(BOARD_FILE);
  if (exists(board.path)) return board;
  const legacy = at(LEGACY_BOARD_FILE);
  if (exists(legacy.path)) return legacy;
  return board;
}

/** "auto" is pull requests when the repository has an origin, else merging here. */
export const resolveDelivery = (setting: DeliverySetting, hasOrigin: boolean): Delivery => (setting === 'auto' ? (hasOrigin ? 'pr' : 'direct') : setting);
