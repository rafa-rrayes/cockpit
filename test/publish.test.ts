import { describe, expect, it } from 'vitest';
import { parseChangelog } from '../src/data/releases';
import { parseRoadmap } from '../src/data/roadmap';
import { emptyState, type State, type WorkItem } from '../src/model';
import { bumpLockfile, bumpVersion, compareVersions, datedChangelog, isReleaseVersion, mergedWork, prBody, prTitle, isShipped, releaseStep, withMerged } from '../src/publish';

const card = (text: string, lane = '0.2.0') => ({ text, lane });

describe('pull request text', () => {
  it('titles a PR after its cards, or the fallback', () => {
    expect(prTitle([card('Welcome link lifetime')], 'commit subject')).toBe('Welcome link lifetime');
    expect(prTitle([card('Short one'), card('Short two')], '')).toBe('Short one; Short two');
    const long = 'A card whose text goes on and on, far past what a pull request title should hold';
    expect(prTitle([card(long)], '')).toHaveLength(72);
    expect(prTitle([card(long), card('b'), card('c')], '')).toMatch(/… \(\+2 more\)$/);
    expect(prTitle([card(long), card('b'), card('c')], '')).toHaveLength(72);
    expect(prTitle([], 'Fix the  login\nflow')).toBe('Fix the login flow');
  });

  it('writes the body from the cards and the report', () => {
    expect(prBody([card('A'), card('B', 'Backlog')], '  Did it.\n')).toBe('Roadmap:\n\n- [x] A (0.2.0)\n- [x] B (Backlog)\n\n## Report\n\nDid it.');
    expect(prBody([], undefined)).toBe('');
    expect(prBody([], 'Only a report')).toBe('## Report\n\nOnly a report');
  });
});

describe('release edits', () => {
  it('bumps the version where a file holds it', () => {
    expect(bumpVersion('package.json', '{\n  "dependencies": { "x": "0.1.1" },\n  "version": "0.1.1"\n}\n', '0.1.1', '0.2.0')).toEqual({
      ok: true,
      text: '{\n  "dependencies": { "x": "0.1.1" },\n  "version": "0.2.0"\n}\n',
    });
    expect(bumpVersion('app.json', '{ "expo": { "version" : "1.4.0" } }', '1.4.0', '1.5.0')).toEqual({ ok: true, text: '{ "expo": { "version" : "1.5.0" } }' });
    expect(bumpVersion('pyproject.toml', '[project]\nversion = "1.4.0"\n', '1.4.0', '1.5.0')).toEqual({ ok: true, text: '[project]\nversion = "1.5.0"\n' });
    expect(bumpVersion('src/version.ts', "export const VERSION = '1.4.0';\n// not 11.4.0 or 1.4.0.1\n", '1.4.0', '1.5.0')).toMatchObject({ ok: true, text: "export const VERSION = '1.5.0';\n// not 11.4.0 or 1.4.0.1\n" });
    expect(bumpVersion('VERSION', '1.4.0\n', '1.4.0', '1.5.0')).toEqual({ ok: true, text: '1.5.0\n' });
    expect(bumpVersion('src/version.ts', "export const VERSION = '11.4.0';", '1.4.0', '1.5.0')).toEqual({ ok: false, error: 'src/version.ts does not hold the version 1.4.0.' });
    expect(bumpVersion('package.json', '{ "version": "1.4.0" }', '1.4', '1.5')).toMatchObject({ ok: false });
  });

  it('dates the Unreleased section in the format the changelog parser reads', () => {
    const text = '# Changelog\n\n## Unreleased\n\n- New\n\n## 0.1.1 - 2026-11-13\n\n- Old\n';
    const out = datedChangelog(text, '0.2.0', '2026-11-14');
    expect(out).toEqual({ ok: true, text: text.replace('## Unreleased', '## Unreleased\n\n## 0.2.0 - 2026-11-14') });
    if (!out.ok) throw new Error(out.error);
    expect(parseChangelog(out.text).slice(0, 2)).toEqual([
      { version: 'Unreleased', lines: [] },
      { version: '0.2.0', date: '2026-11-14', lines: ['New'] },
    ]);
    expect(datedChangelog('## [Unreleased]\r\n- x\r\n', '1.0.0', '2026-01-02')).toEqual({ ok: true, text: '## [Unreleased]\r\n\r\n## [1.0.0] - 2026-01-02\r\n- x\r\n' });
    expect(datedChangelog('```\n## Unreleased\n```\n', '1.0.0', 'd')).toMatchObject({ ok: false });
    expect(datedChangelog('## Unreleased\n\n## 1.0.0 - 2026-01-01\n', '1.0.0', 'd')).toEqual({ ok: false, error: 'CHANGELOG.md already has 1.0.0.' });
  });

  it('compares versions by number, a pre-release first', () => {
    expect(compareVersions('v1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.2.0', 'v1.2.0')).toBe(0);
    expect(compareVersions('1.2.0-rc.1', '1.2.0')).toBeLessThan(0);
    expect(isReleaseVersion('1.2.0')).toBe(true);
    expect(isReleaseVersion('1.2')).toBe(false);
    expect(isReleaseVersion('1.2.0;rm')).toBe(false);
  });
});

describe('releaseStep', () => {
  const lanes = parseRoadmap('## 0.2.0\n\n- [x] a\n- [x] b\n\n## 0.3.0\n\n- [x] c\n- [ ] d\n\n## 0.1.0\nStatus: shipped\n\n- [x] old\n\n## Backlog\n\n- [x] e\n');
  const lane = (v: string) => {
    const found = lanes.find((l) => l.version === v);
    if (!found) throw new Error(`no lane ${v}`);
    return found;
  };
  const s = (extra: { latestTag?: string; items?: WorkItem[] } = {}): State => {
    const base = emptyState();
    return { ...base, work: { ...base.work, items: extra.items ?? [] }, releases: { ...base.releases, roadmap: lanes, ...(extra.latestTag ? { latestTag: extra.latestTag } : {}) } };
  };
  const pr = (state: 'open' | 'merged') => ({ number: 4, title: 'Release 0.2.0', url: 'u', branch: 'release-0.2.0', isDraft: false, state, checks: { state: 'none' as const } });
  const release = (state: 'open' | 'merged'): WorkItem => ({ branch: 'release-0.2.0', isDefault: false, isCurrent: false, group: 'active', dirtyCount: 0, ahead: 1, behind: 0, pushed: true, sessionIds: [], pr: pr(state) });

  it('offers Release when every card is done, the PR while it is open, Tag once merged or shipped', () => {
    expect(releaseStep(lane('0.2.0'), s({ latestTag: 'v0.1.0' }))).toEqual({ step: 'release' });
    expect(releaseStep(lane('0.2.0'), s({ items: [release('open')] }))).toEqual({ step: 'review', pr: pr('open') });
    expect(releaseStep(lane('0.2.0'), s({ items: [release('merged')] }))).toEqual({ step: 'tag' });
    expect(releaseStep(lane('0.1.0'), s())).toEqual({ step: 'tag' });
  });

  it('in direct delivery: Release when every card is done, Tag only for a lane that says shipped, never a review', () => {
    const direct = (extra: Parameters<typeof s>[0] = {}): State => {
      const st = s(extra);
      return { ...st, work: { ...st.work, delivery: 'direct' } };
    };
    expect(releaseStep(lane('0.2.0'), direct())).toEqual({ step: 'release' });
    // A release pull request (of an earlier pr setup) does not count.
    expect(releaseStep(lane('0.2.0'), direct({ items: [release('open')] }))).toEqual({ step: 'release' });
    expect(releaseStep(lane('0.2.0'), direct({ items: [release('merged')] }))).toEqual({ step: 'release' });
    expect(releaseStep(lane('0.1.0'), direct())).toEqual({ step: 'tag' });
    expect(releaseStep(lane('0.1.0'), direct({ latestTag: 'v0.1.0' }))).toBeUndefined();
    expect(releaseStep(lane('0.3.0'), direct())).toBeUndefined();
  });

  it('offers nothing for open cards, the backlog, or a version already tagged', () => {
    expect(releaseStep(lane('0.3.0'), s())).toBeUndefined();
    expect(releaseStep(lane('Backlog'), s())).toBeUndefined();
    expect(releaseStep(lane('0.1.0'), s({ latestTag: 'v0.1.0' }))).toBeUndefined();
    expect(releaseStep(lane('0.2.0'), s({ latestTag: 'v0.2.1' }))).toBeUndefined();
  });

  it('counts a lane as shipped once it says so and a tag at or after it exists', () => {
    expect(isShipped(lane('0.1.0'), s({ latestTag: 'v0.1.0' }))).toBe(true);
    expect(isShipped(lane('0.1.0'), s({ latestTag: 'v0.3.0' }))).toBe(true);
    // Says shipped, not tagged yet: it keeps its Tag button.
    expect(isShipped(lane('0.1.0'), s())).toBe(false);
    // Tagged past it, but it does not say shipped.
    expect(isShipped(lane('0.2.0'), s({ latestTag: 'v0.3.0' }))).toBe(false);
    expect(isShipped(lane('Backlog'), s({ latestTag: 'v9.0.0' }))).toBe(false);
  });
});

describe('withMerged and mergedWork', () => {
  const item = (branch: string, state?: 'open' | 'merged', isDefault = false): WorkItem => ({
    branch,
    isDefault,
    isCurrent: false,
    group: 'merged',
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    pushed: true,
    sessionIds: [],
    ...(state ? { pr: { number: 1, title: '', url: '', branch, isDraft: false, state, checks: { state: 'none' as const } } } : {}),
  });

  it('shows linked cards and release lanes whose pull request merged as done and shipped, and names them', () => {
    const roadmap = parseRoadmap('## 0.2.0\n\n- [~] a <!-- cockpit:wa -->\n- [~] b <!-- cockpit:wb -->\n- [~] c <!-- cockpit:wa -->\n\n## 0.1.0\nStatus: shipped\n\n## 0.1.5\nStatus: in review\n\n- [x] d\n');
    const items = [item('wa', 'merged'), item('wb', 'open'), item('release-0.1.0', 'merged'), item('release-0.1.5', 'merged')];
    const lanes = withMerged(roadmap, items);
    expect(lanes.map((l) => [l.version, l.status, l.merged, ...l.items.map((i) => `${i.status}:${i.text}:${i.branch ?? ''}:${i.merged ? 'merged' : ''}`)])).toEqual([
      ['0.2.0', undefined, undefined, 'done:a:wa:merged', 'doing:b:wb:', 'done:c:wa:merged'],
      ['0.1.0', 'shipped', undefined],
      ['0.1.5', 'shipped', true, 'done:d::'],
    ]);
    // The ids stay the file's, so board edits still name the right lines.
    expect(lanes[0]?.items.map((i) => i.id)).toEqual(roadmap[0]?.items.map((i) => i.id));
    expect(mergedWork(lanes)).toEqual({ branches: ['wa'], versions: ['0.1.5'] });
  });

  it('leaves the board as it is when nothing merged, and never counts the default branch', () => {
    const roadmap = parseRoadmap('## 0.2.0\n\n- [~] a <!-- cockpit:main -->\n');
    expect(withMerged(roadmap, [item('main', 'merged', true), item('wb', 'open')])).toEqual(roadmap);
    expect(mergedWork(roadmap)).toEqual({ branches: [], versions: [] });
  });

  it('feeds releaseStep: a merged release lane is ready to tag', () => {
    const roadmap = parseRoadmap('## 0.2.0\n\n- [~] a <!-- cockpit:wa -->\n');
    const base = emptyState();
    const items = [item('wa', 'merged')];
    const s: State = { ...base, work: { ...base.work, items }, releases: { ...base.releases, roadmap: withMerged(roadmap, items) } };
    const lane = s.releases.roadmap[0];
    if (!lane) throw new Error('no lane');
    expect(releaseStep(lane, s)).toEqual({ step: 'release' });
  });
});

describe('bumpLockfile', () => {
  const lock = (top: string, root: string) =>
    `{\n  "name": "app",\n  "version": "${top}",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "app",\n      "version": "${root}",\n      "devDependencies": { "dep": "^0.2.2" }\n    },\n    "node_modules/dep": {\n      "version": "0.2.2"\n    }\n  }\n}\n`;

  it('sets the root version in both places, whatever they held, and leaves dependencies alone', () => {
    expect(bumpLockfile(lock('0.2.2', '0.2.2'), '0.3.2')).toEqual({ ok: true, text: lock('0.3.2', '0.3.2') });
    expect(bumpLockfile(lock('0.1.0', '0.2.2'), '0.3.2')).toEqual({ ok: true, text: lock('0.3.2', '0.3.2') });
  });

  it('handles a v1 lockfile with no packages section, and refuses what is not a lockfile', () => {
    expect(bumpLockfile('{\n  "name": "app",\n  "version": "1.0.0",\n  "lockfileVersion": 1\n}\n', '1.1.0')).toEqual({ ok: true, text: '{\n  "name": "app",\n  "version": "1.1.0",\n  "lockfileVersion": 1\n}\n' });
    expect(bumpLockfile('not json', '1.0.0')).toEqual({ ok: false, error: 'package-lock.json is not valid JSON.' });
    expect(bumpLockfile('{\n  "name": "app"\n}\n', '1.0.0')).toEqual({ ok: false, error: 'package-lock.json holds no version.' });
  });
});
