import { describe, expect, it } from 'vitest';
import { parseMessage } from '../src/guards';
import { STANDARD_STEPS, defaultLaunch, launchPrompt } from '../src/launch';
import { boardMembers, defaultSettings, isProjectSetting, parseSettingEdit, readSettings, storedValue } from '../src/settings';

const from = (config: Record<string, unknown>) => readSettings((key) => config[key]);

describe('readSettings', () => {
  it('gives the defaults for an empty configuration', () => {
    expect(from({})).toEqual(defaultSettings);
  });

  it('reads what VS Code holds, as the launcher and the page use it', () => {
    const s = from({
      openOnStartup: false,
      endedSessionDays: 3,
      hiddenSections: ['work', 'activity', 'work'],
      'launch.model': 'opus',
      'launch.effort': 'max',
      'launch.subagents': 2,
      'launch.subagentModel': 'haiku',
      'launch.worktree': false,
      promptSteps: ['Be brief.'],
    });
    expect(s.openOnStartup).toBe(false);
    expect(s.endedSessionDays).toBe(3);
    expect(s.hiddenSections).toEqual(['work', 'activity']);
    expect(s.launch).toEqual({ model: 'opus', effort: 'max', subagents: 2, subagentModel: 'haiku', worktree: false, markDoing: true });
    expect(s.promptSteps).toEqual(['Be brief.']);
  });

  it('reads whether Claudes shows every project, all of them by default', () => {
    expect(from({}).showAllProjects).toBe(true);
    expect(from({ 'claudes.showAllProjects': false }).showAllProjects).toBe(false);
    expect(from({ 'claudes.showAllProjects': 'no' }).showAllProjects).toBe(true);
  });

  it('marks the settings that belong to one project', () => {
    expect(isProjectSetting('release.versionFiles')).toBe(true);
    expect(isProjectSetting('promptSteps')).toBe(true);
    expect(isProjectSetting('launch.model')).toBe(false);
    expect(isProjectSetting('claudes.showAllProjects')).toBe(false);
    expect(parseSettingEdit({ key: 'claudes.showAllProjects', value: false })).toEqual({ key: 'claudes.showAllProjects', value: false });
  });

  it('reads "default" and "auto" as no model, and drops the subagent model without subagents', () => {
    expect(from({ 'launch.model': 'default', 'launch.subagentModel': 'auto', 'launch.subagents': 2 }).launch).toEqual({ ...defaultLaunch, subagents: 2 });
    expect(from({ 'launch.subagentModel': 'haiku' }).launch.subagentModel).toBeUndefined();
  });

  it('turns anything a person mistyped in settings.json into the default, and clamps numbers', () => {
    const s = from({
      openOnStartup: 'yes',
      endedSessionDays: 200,
      githubPollSeconds: 2,
      hiddenSections: ['work', 'nope'],
      'launch.model': 'gpt',
      'launch.subagents': 12,
      promptSteps: ['Keep it.', '', 7, '   '],
      'release.versionFiles': ['app.json', '../outside', '/abs', '-x', 'app.json', 'src/version.ts'],
    });
    expect(s.openOnStartup).toBe(true);
    expect(s.endedSessionDays).toBe(90);
    expect(s.githubPollSeconds).toBe(15);
    expect(s.hiddenSections).toEqual([]);
    expect(s.launch.model).toBeUndefined();
    expect(s.launch.subagents).toBe(0);
    expect(s.promptSteps).toEqual(['Keep it.']);
    expect(s.releaseVersionFiles).toEqual(['app.json', 'src/version.ts']);
  });
});

describe('setting edits', () => {
  it('takes known keys with values of the right kind', () => {
    expect(parseSettingEdit({ key: 'endedSessionDays', value: 14 })).toEqual({ key: 'endedSessionDays', value: 14 });
    expect(parseSettingEdit({ key: 'launch.model', value: 'default' })).toEqual({ key: 'launch.model', value: 'default' });
    expect(parseSettingEdit({ key: 'hiddenSections', value: ['work', 'work'] })).toEqual({ key: 'hiddenSections', value: ['work'] });
  });

  it('refuses anything else', () => {
    for (const edit of [
      undefined,
      { key: 'zenMode.fullScreen', value: true },
      { key: 'constructor', value: true },
      { key: 'endedSessionDays', value: 91 },
      { key: 'endedSessionDays', value: 1.5 },
      { key: 'githubPollSeconds', value: 5 },
      { key: 'launch.model', value: '--dangerously-skip-permissions' },
      { key: 'launch.subagents', value: 9 },
      { key: 'hiddenSections', value: ['nope'] },
      { key: 'promptSteps', value: [''] },
      { key: 'promptSteps', value: ['x'.repeat(1001)] },
      { key: 'promptSteps', value: Array.from({ length: 31 }, () => 'x') },
      { key: 'release.versionFiles', value: ['../package.json'] },
      { key: 'release.versionFiles', value: ['--output=x'] },
      { key: 'release.versionFiles', value: ['a//b'] },
    ]) {
      expect(parseSettingEdit(edit)).toBeUndefined();
    }
  });

  it('comes through the message guard', () => {
    expect(parseMessage({ type: 'setSetting', edit: { key: 'openOnStartup', value: false } })).toEqual({ type: 'setSetting', edit: { key: 'openOnStartup', value: false } });
    expect(parseMessage({ type: 'setSetting', edit: { key: 'openOnStartup', value: 'no' } })).toBeUndefined();
    expect(parseMessage({ type: 'openSettings' })).toEqual({ type: 'openSettings' });
  });

  it('removes a setting set back to its default instead of pinning it', () => {
    expect(storedValue({ key: 'endedSessionDays', value: 7 })).toBeUndefined();
    expect(storedValue({ key: 'launch.model', value: 'default' })).toBeUndefined();
    expect(storedValue({ key: 'promptSteps', value: [] })).toBeUndefined();
    expect(storedValue({ key: 'endedSessionDays', value: 3 })).toBe(3);
  });
});

describe('custom prompt steps', () => {
  const card = { text: 'Dark mode', lane: 'Backlog' };

  it('replace the standard ones and keep the steps the options give', () => {
    const p = launchPrompt([card], defaultLaunch, 'shop', ['Read AGENTS.md first.', 'Write tests first.']);
    expect(p).toContain('1. Read AGENTS.md first.\n2. You are in a new git worktree');
    expect(p).toContain('3. Write tests first.\n4. Commit on this branch');
    expect(p).toContain('5. Do the work yourself');
    expect(p).not.toContain('Leave ROADMAP.md alone');
  });

  it('are the standard ones when none are set', () => {
    const p = launchPrompt([card], defaultLaunch, 'shop', []);
    for (const step of STANDARD_STEPS) expect(p).toContain(step);
    expect(p).toBe(launchPrompt([card], defaultLaunch, 'shop'));
  });
});

describe('members', () => {
  const rafa = { name: 'Rafa', color: '#D97757' };
  const claude = { name: 'Claude', color: '#4f8ff7' };

  it('reads global and project members, dropping bad entries and repeated names', () => {
    const s = from({ members: [rafa, { name: 'rafa', color: '#000000' }, { name: 'x', color: 'red' }, 'Bob', claude], projectMembers: [{ name: 'Ana', color: '#3fb68b' }] });
    expect(s.members).toEqual([{ name: 'Rafa', color: '#d97757' }, claude]);
    expect(s.projectMembers).toEqual([{ name: 'Ana', color: '#3fb68b' }]);
    expect(from({ members: 'Rafa' }).members).toEqual([]);
  });

  it('keeps project members to the workspace', () => {
    expect(isProjectSetting('projectMembers')).toBe(true);
    expect(isProjectSetting('members')).toBe(false);
  });

  it('accepts an edit of valid, distinct members only', () => {
    expect(parseSettingEdit({ key: 'members', value: [rafa, claude] })).toEqual({ key: 'members', value: [{ name: 'Rafa', color: '#d97757' }, claude] });
    expect(parseSettingEdit({ key: 'members', value: [rafa, { ...rafa, name: 'RAFA' }] })).toBeUndefined();
    expect(parseSettingEdit({ key: 'projectMembers', value: [{ name: 'a-->', color: '#000000' }] })).toBeUndefined();
    expect(storedValue({ key: 'members', value: [] })).toBeUndefined();
  });

  it('lists project members first, replacing a global one of the same name', () => {
    const local = { name: 'rafa', color: '#000000' };
    expect(boardMembers({ members: [rafa, claude], projectMembers: [local] })).toEqual([local, claude]);
  });
});
