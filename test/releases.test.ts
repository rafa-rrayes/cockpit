import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseChangelog, parseLatestTag, parseRoadmap, readReleases, versionFrom } from '../src/data/releases';
import { loadGit } from '../src/sources';

const dir = join(__dirname, 'fixtures/releases');
const fixture = (name: string) => readFileSync(join(dir, name), 'utf8');

describe('parseRoadmap', () => {
  // The backlog lane ("## Later") has its own tests in roadmap.test.ts.
  const plans = parseRoadmap(fixture('ROADMAP.md')).filter((p) => !p.backlog);

  it('reads each release heading, all three separators and an optional v or brackets', () => {
    expect(plans.map((p) => [p.version, p.title])).toEqual([
      ['1.2.0', 'Community'],
      ['1.3.0', 'Payments abroad'],
      ['2.0.0', 'Big rewrite'],
      ['1.4.0', undefined],
    ]);
  });

  it('reads target, status (also in bold) and the items', () => {
    expect(plans[0]).toMatchObject({
      version: '1.2.0',
      title: 'Community',
      target: 'week of 2026-11-16',
      status: 'in progress',
      items: [
        { text: 'Seasons and a leaderboard', status: 'done' },
        { text: 'Video feed', status: 'todo' },
        { text: 'Upload from the app', status: 'done' },
        { text: 'Comments on posts', status: 'todo' },
        { text: 'Moderation tools', status: 'todo' },
      ],
    });
    expect(plans[1]).toMatchObject({ target: 'December', status: 'planned', items: [{ text: 'Card checkout in USD', status: 'todo' }, { text: 'Payouts', status: 'todo' }] });
    expect(plans[2]?.items).toEqual([]);
    expect(plans[3]).toMatchObject({ status: 'planned', items: [{ text: 'Numbered items work too', status: 'todo' }] });
  });

  it('skips numbered section headings and anything inside code fences', () => {
    expect(parseRoadmap('## 1. Foundations\n- a\n## 2) Later\n- b\n')).toEqual([]);
    expect(parseRoadmap('## v2 — Big\n```md\n## 9.9.9 fake\n- [ ] not an item\n```\n- [x] real\n~~~\n## 8.8 fake\n~~~\n')).toMatchObject([
      { version: '2', title: 'Big', items: [{ text: 'real', status: 'done' }] },
    ]);
    expect(parseChangelog('## 1.0.0\n- kept\n````\n```\n## 9.9.9\n- example\n````\n- also kept\n')).toEqual([{ version: '1.0.0', lines: ['kept', 'also kept'] }]);
  });

  it('skips non-version headings and their items, and tolerates junk', () => {
    expect(plans.flatMap((p) => p.items.map((i) => i.text))).not.toContain('Dark mode');
    expect(parseRoadmap('')).toEqual([]);
    expect(parseRoadmap('- [ ] an item before any heading\n## 1.0\n')).toEqual([{ version: '1.0', items: [] }]);
  });
});

describe('parseChangelog', () => {
  const entries = parseChangelog(fixture('CHANGELOG.md'));

  it('puts Unreleased first and keeps at most 5 entries in file order', () => {
    expect(entries.map((e) => [e.version, e.date])).toEqual([
      ['Unreleased', undefined],
      ['1.1.0', '2026-10-27'],
      ['1.0.1', '2026-10-20'],
      ['1.0.0', '2026-10-01'],
      ['0.9.0', undefined],
    ]);
  });

  it('keeps items under sub-headings and joins continuation lines', () => {
    expect(entries[0]?.lines).toEqual([
      'Search filters by city and price',
      'An export of orders as CSV, with one row per item',
      'The checkout fee shows before the last step',
    ]);
    expect(entries[1]?.lines).toEqual(['A map on the store page']);
  });

  it('accepts an Unreleased that is not first, and junk', () => {
    expect(parseChangelog('## 1.0.0 - 2026-01-01\n- a\n## Unreleased\n- b\n').map((e) => e.version)).toEqual(['Unreleased', '1.0.0']);
    expect(parseChangelog('nothing here')).toEqual([]);
  });
});

describe('versionFrom', () => {
  it('reads each manifest', () => {
    expect(versionFrom('package.json', fixture('package.json'))).toBe('2.5.0');
    expect(versionFrom('app/app.json', fixture('app.json'))).toBe('1.1.0');
    expect(versionFrom('pyproject.toml', fixture('pyproject.toml'))).toBe('0.4.2');
    expect(versionFrom('Cargo.toml', fixture('Cargo.toml'))).toBe('0.3.0');
  });

  it('returns undefined when a manifest has no version', () => {
    expect(versionFrom('pyproject.toml', fixture('pyproject-dynamic.toml'))).toBeUndefined();
    expect(versionFrom('package.json', '{"name":"x","private":true}')).toBeUndefined();
    expect(versionFrom('package.json', '{ broken')).toBeUndefined();
  });

  it('parses the first v* tag line', () => {
    expect(parseLatestTag('v1.10.0\t1794000000\nv1.9.0\t1793000000\n')).toEqual({ tag: 'v1.10.0', at: 1794000000_000 });
    expect(parseLatestTag('very-old\t1\nv2\t\n')).toEqual({ tag: 'v2' });
    expect(parseLatestTag('')).toBeUndefined();
  });
});

describe('readReleases on a real repository', () => {
  let base: string;
  const sh = (cwd: string, args: string[]) =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], {
      cwd,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const commit = (cwd: string, msg: string) => {
    writeFileSync(join(cwd, `${msg}.txt`), msg);
    sh(cwd, ['add', '.']);
    sh(cwd, ['commit', '-q', '-m', msg]);
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'cockpit-rel-'));
  });
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it('reads the version source in order, the newest v* tag by version and commits since it', async () => {
    const repo = join(base, 'tagged');
    mkdirSync(join(repo, 'app'), { recursive: true });
    copyFileSync(join(dir, 'app.json'), join(repo, 'app', 'app.json'));
    copyFileSync(join(dir, 'pyproject.toml'), join(repo, 'pyproject.toml'));
    copyFileSync(join(dir, 'ROADMAP.md'), join(repo, 'ROADMAP.md'));
    sh(repo, ['init', '-q', '-b', 'main']);
    commit(repo, 'one');
    sh(repo, ['tag', 'v0.9.0']);
    commit(repo, 'two');
    sh(repo, ['tag', '-a', '-m', 'release', 'v0.10.0']);
    sh(repo, ['tag', 'v0.10.0-rc1', 'HEAD~1']);
    commit(repo, 'three');
    commit(repo, 'four');

    const r = await readReleases(repo);
    expect(r).toMatchObject({ available: true, currentVersion: '1.1.0', versionSource: 'app/app.json', latestTag: 'v0.10.0', commitsSinceTag: 2 });
    expect(r.latestTagAt).toBeGreaterThan(0);
    expect(r.roadmap).toHaveLength(5);
    expect(r.changelog).toEqual([]);
  });

  it('reads the files of the worktree that is open, and the tags of the repository', async () => {
    const repo = join(base, 'with-worktree');
    mkdirSync(repo);
    writeFileSync(join(repo, 'package.json'), '{ "version": "1.0.0" }\n');
    writeFileSync(join(repo, 'CHANGELOG.md'), '## Unreleased\n- main line\n');
    sh(repo, ['init', '-q', '-b', 'main']);
    commit(repo, 'one');
    sh(repo, ['tag', 'v1.0.0']);
    const wt = join(base, 'with-worktree-feat');
    sh(repo, ['worktree', 'add', '-q', '-b', 'feat', wt]);
    writeFileSync(join(wt, 'package.json'), '{ "version": "2.0.0" }\n');
    writeFileSync(join(wt, 'CHANGELOG.md'), '## Unreleased\n- feature line\n');
    const { releases } = await loadGit(wt, Date.now());
    expect(releases).toMatchObject({ currentVersion: '2.0.0', latestTag: 'v1.0.0', changelog: [{ version: 'Unreleased', lines: ['feature line'] }] });
    expect((await loadGit(repo, Date.now())).releases).toMatchObject({ currentVersion: '1.0.0', changelog: [{ lines: ['main line'] }] });
  });

  it('is unavailable with nothing to show, and works outside git', async () => {
    const empty = join(base, 'empty');
    mkdirSync(empty);
    const roadmapPath = join(empty, 'ROADMAP.md');
    expect(await readReleases(empty)).toEqual({ available: false, roadmapPath, roadmapExists: false, roadmap: [], changelog: [] });
    writeFileSync(join(empty, 'CHANGELOG.md'), '# Changelog\n');
    expect(await readReleases(empty)).toEqual({ available: true, roadmapPath, roadmapExists: false, roadmap: [], changelog: [] });
  });
});
