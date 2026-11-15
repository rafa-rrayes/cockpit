// Cockpit's VS Code settings (cockpit.*), as the settings popover shows and edits them. Kept free of `vscode` and
// node modules: the webview imports the keys and sections, and reading and checking them is unit-tested. The host
// reads them with `readSettings(key => ...)` and writes an edit with `config.update(key, storedValue)`: a project
// setting (isProjectSetting) from and to the workspace's settings, the others from and to the user's.
import { EFFORTS, MAX_SUBAGENTS, MODELS, defaultLaunch } from './launch';
import { isMemberName } from './data/roadmap';
import type { ClaudeModel, LaunchOptions, Member, SectionId, Settings } from './model';

export const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'needs', label: 'Needs you' },
  { id: 'claudes', label: 'Claudes' },
  { id: 'roadmap', label: 'Roadmap' },
  { id: 'work', label: 'Work' },
  { id: 'releases', label: 'Releases' },
  { id: 'activity', label: 'Activity' },
];

export const MAX_ENDED_DAYS = 90;
export const MIN_GITHUB_SECONDS = 15;
export const MAX_PROMPT_STEPS = 30;
export const MAX_PROMPT_STEP_CHARS = 1000;
export const MAX_VERSION_FILES = 20;
export const MAX_MEMBERS = 30;

export const defaultSettings: Settings = {
  openOnStartup: true,
  showAllProjects: true,
  endedSessionDays: 7,
  githubPollSeconds: 60,
  hiddenSections: [],
  launch: defaultLaunch,
  promptSteps: [],
  releaseVersionFiles: [],
  members: [],
  projectMembers: [],
};

/** A path inside the repository, written with "/": no absolute path, no "..", nothing a command line could read as an
 *  option. */
export const isRepoFile = (v: unknown): v is string =>
  typeof v === 'string' && v.length <= 200 && /^[A-Za-z0-9_][A-Za-z0-9_./ -]*$/.test(v) && !v.split('/').some((p) => p === '..' || p === '.' || p === '');

export const isMemberColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
const isMember = (v: unknown): v is Member =>
  typeof v === 'object' && v !== null && isMemberName((v as Member).name) && isMemberColor((v as Member).color);
export const sameMember = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
const isMembers = (v: unknown): v is Member[] =>
  Array.isArray(v) && v.length <= MAX_MEMBERS && v.every(isMember) && new Set(v.map((m: Member) => m.name.toLowerCase())).size === v.length;

const isModel = (v: unknown): v is ClaudeModel => MODELS.some((m) => m.model !== undefined && m.model === v);
const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isSection = (v: unknown): v is SectionId => SECTIONS.some((s) => s.id === v);

/** Every setting the popover edits: its key under `cockpit.`, its default as stored, and what a value must be.
 *  `project: true` marks a setting of one project: it is written to and read from the workspace's settings only, so a
 *  value set for one project never leaks into another. The rest are the person's, for every project. */
const SETTINGS = {
  openOnStartup: { stored: true, ok: (v: unknown) => typeof v === 'boolean' },
  'claudes.showAllProjects': { stored: true, ok: (v: unknown) => typeof v === 'boolean' },
  endedSessionDays: { stored: 7, ok: (v: unknown) => isInt(v, 0, MAX_ENDED_DAYS) },
  githubPollSeconds: { stored: 60, ok: (v: unknown) => isInt(v, MIN_GITHUB_SECONDS, Number.MAX_SAFE_INTEGER) },
  hiddenSections: { stored: [] as SectionId[], ok: (v: unknown) => Array.isArray(v) && v.every(isSection) },
  'launch.model': { stored: 'default', ok: (v: unknown) => v === 'default' || isModel(v) },
  'launch.effort': { stored: defaultLaunch.effort, ok: (v: unknown) => EFFORTS.includes(v as never) },
  'launch.subagents': { stored: defaultLaunch.subagents, ok: (v: unknown) => isInt(v, 0, MAX_SUBAGENTS) },
  'launch.subagentModel': { stored: 'auto', ok: (v: unknown) => v === 'auto' || isModel(v) },
  'launch.worktree': { stored: defaultLaunch.worktree, ok: (v: unknown) => typeof v === 'boolean' },
  'launch.markDoing': { stored: defaultLaunch.markDoing, ok: (v: unknown) => typeof v === 'boolean' },
  promptSteps: {
    project: true,
    stored: [] as string[],
    ok: (v: unknown) => Array.isArray(v) && v.length <= MAX_PROMPT_STEPS && v.every((s) => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_PROMPT_STEP_CHARS),
  },
  'release.versionFiles': { project: true, stored: [] as string[], ok: (v: unknown) => Array.isArray(v) && v.length <= MAX_VERSION_FILES && v.every(isRepoFile) },
  members: { stored: [] as Member[], ok: isMembers },
  projectMembers: { project: true, stored: [] as Member[], ok: isMembers },
} as const;

export type SettingKey = keyof typeof SETTINGS;

/** One change from the popover: a key and the value to store under it. */
export interface SettingEdit {
  key: SettingKey;
  value: unknown;
}

/** Whether a setting belongs to one project (the workspace's settings) rather than to every project (the user's). */
export const isProjectSetting = (key: SettingKey): boolean => 'project' in SETTINGS[key];

const isKey = (k: unknown): k is SettingKey => typeof k === 'string' && Object.hasOwn(SETTINGS, k);

/** The edit, if its key is known and its value is one that key takes; undefined otherwise. */
export function parseSettingEdit(raw: unknown): SettingEdit | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const { key, value } = raw as Record<string, unknown>;
  if (!isKey(key) || !SETTINGS[key].ok(value)) return undefined;
  if (key === 'members' || key === 'projectMembers') return { key, value: (value as Member[]).map((m) => ({ name: m.name, color: m.color.toLowerCase() })) };
  return { key, value: Array.isArray(value) ? [...new Set(value)] : value };
}

/** What to write for an edit: undefined when it is the default, so the setting is removed from settings.json
 *  instead of pinned there. */
export function storedValue(edit: SettingEdit): unknown {
  const fallback = SETTINGS[edit.key].stored;
  return JSON.stringify(edit.value) === JSON.stringify(fallback) ? undefined : edit.value;
}

/** The custom prompt steps as written, without blank or overlong lines: a stray empty line in settings.json
 *  should not throw the rest away. */
function readSteps(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_PROMPT_STEP_CHARS).slice(0, MAX_PROMPT_STEPS);
}

/** The version files as written, without the paths that are not files of the repository: one bad entry should not
 *  throw the rest away either. */
function readFiles(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter(isRepoFile))].slice(0, MAX_VERSION_FILES);
}

/** The members as written, without the entries that are not a member, or that repeat a name. */
function readMembers(v: unknown): Member[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: Member[] = [];
  for (const m of v) {
    if (!isMember(m) || seen.has(m.name.toLowerCase())) continue;
    seen.add(m.name.toLowerCase());
    out.push({ name: m.name, color: m.color.toLowerCase() });
  }
  return out.slice(0, MAX_MEMBERS);
}

/** Everyone a card can be assigned to: this project's members, then the global ones it does not rename. */
export function boardMembers(s: Pick<Settings, 'members' | 'projectMembers'>): Member[] {
  return [...s.projectMembers, ...s.members.filter((g) => !s.projectMembers.some((p) => sameMember(p.name, g.name)))];
}

/** The settings as `get` returns them (VS Code's configuration, which may hold anything a person typed into
 *  settings.json): every value of the wrong kind is its default. */
export function readSettings(get: (key: SettingKey) => unknown): Settings {
  const read = <K extends SettingKey>(key: K): unknown => {
    const v = get(key);
    return SETTINGS[key].ok(v) ? v : SETTINGS[key].stored;
  };
  // Numbers out of range in settings.json are clamped rather than dropped: 200 days reads as the most there is.
  const num = (key: 'endedSessionDays' | 'githubPollSeconds', min: number, max: number): number => {
    const v = get(key);
    return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : (SETTINGS[key].stored as number);
  };
  const model = read('launch.model');
  const subagentModel = read('launch.subagentModel');
  const subagents = read('launch.subagents') as number;
  const launch: LaunchOptions = {
    effort: read('launch.effort') as LaunchOptions['effort'],
    subagents,
    worktree: read('launch.worktree') as boolean,
    markDoing: read('launch.markDoing') as boolean,
  };
  if (isModel(model)) launch.model = model;
  if (isModel(subagentModel) && subagents > 0) launch.subagentModel = subagentModel;
  return {
    openOnStartup: read('openOnStartup') as boolean,
    showAllProjects: read('claudes.showAllProjects') as boolean,
    endedSessionDays: num('endedSessionDays', 0, MAX_ENDED_DAYS),
    githubPollSeconds: num('githubPollSeconds', MIN_GITHUB_SECONDS, Number.MAX_SAFE_INTEGER),
    hiddenSections: [...new Set(read('hiddenSections') as SectionId[])],
    launch,
    promptSteps: readSteps(get('promptSteps')),
    releaseVersionFiles: readFiles(get('release.versionFiles')),
    members: readMembers(get('members')),
    projectMembers: readMembers(get('projectMembers')),
  };
}
