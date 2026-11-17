// Ship, Release, Tag and Pull end to end against real repositories. For `pr` delivery the remote is a local bare
// one, with a second clone standing in for GitHub's merge button; gh is replaced by a function that records what it
// was asked and answers like gh does. For `direct` delivery, repositories with no remote, and one with a local bare
// origin to push to. Nothing leaves the machine.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureCockpitDir } from '../src/data/cockpitDir';
import { finishMerged, linkCard, parseRoadmap, setLaneStatus } from '../src/data/roadmap';
import type { RunResult } from '../src/data/git';
import { prBody, prTitle, releaseBody, releaseTitle } from '../src/publish';
import { commitRelease, draftDirect, draftRelease, findDirectTag, findRelease, type Gh, isTracked, mergeBranch, openRelease, prsFrom, pullDefault, pushTag, shipBranch } from '../src/ship';

const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: '', timedOut: false });
const failed = (stderr: string): RunResult => ({ ok: false, stdout: '', stderr, code: 1, timedOut: false });

/** A stand-in for gh: records every call, answers `pr list` from `prs` and `pr create` with a URL. */
function fakeGh(prs: Record<string, unknown[]> = {}, create: RunResult = ok('https://github.com/o/r/pull/1\n')) {
  const calls: string[][] = [];
  const gh: Gh = async (_cwd, args) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return ok(JSON.stringify(prs[args[args.indexOf('--head') + 1] ?? ''] ?? []));
    if (args[0] === 'pr' && args[1] === 'create') return create;
    return failed(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls };
}

let base: string;
let repo: string;
let hub: string;
const sh = (cwd: string, args: string[]) =>
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const configure = (dir: string) => {
  sh(dir, ['config', 'user.name', 'Test']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  sh(dir, ['config', 'commit.gpgsign', 'false']);
  sh(dir, ['config', 'tag.gpgsign', 'false']);
  // Cockpit's own git runs read the repository's config: no hook of the machine's runs in the tests.
  sh(dir, ['config', 'core.hooksPath', '/dev/null']);
};
const read = (path: string) => readFileSync(path, 'utf8');
const status = (dir: string) => sh(dir, ['status', '--porcelain']).trim();
const wt = (name: string, root = repo) => join(root, '.claude', 'worktrees', name);
/** The GitHub side: merges a branch of the remote into main and pushes, as the merge button would. */
const merge = (branch: string, how: 'squash' | 'merge'): string => {
  sh(hub, ['fetch', '--quiet', 'origin']);
  sh(hub, ['reset', '--quiet', '--hard', 'origin/main']);
  if (how === 'squash') {
    sh(hub, ['merge', '--quiet', '--squash', `origin/${branch}`]);
    sh(hub, ['commit', '--quiet', '-m', `${branch} (#1)`]);
  } else sh(hub, ['merge', '--quiet', '--no-ff', '-m', `Merge ${branch}`, `origin/${branch}`]);
  sh(hub, ['push', '--quiet', 'origin', 'main']);
  return sh(hub, ['rev-parse', 'HEAD']).trim();
};
const roadmapPath = () => join(repo, 'ROADMAP.md');
const idOf = (text: string, card: string) => parseRoadmap(text).flatMap((l) => l.items).find((i) => i.text === card)?.id ?? '';
const change = (r: { ok: true; text: string } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.text;
};
const INITIAL_ROADMAP = '# Roadmap\n\n## 0.2.0\n\n- [ ] Card A\n- [ ] Card B\n\n## Backlog\n\n- [ ] Idea\n';
const CHANGELOG = '# Changelog\n\n## Unreleased\n\n- Card A\n- Card B\n\n## 0.1.0 - 2026-11-01\n\n- First\n';

/** A repository with package.json at 0.1.0, a changelog, app.txt and, when given, a tracked ROADMAP.md. */
function makeRepo(dir: string, roadmap?: string): void {
  mkdirSync(dir);
  sh(dir, ['init', '--quiet', '-b', 'main']);
  configure(dir);
  writeFileSync(join(dir, '.gitignore'), '.claude/\n');
  if (roadmap !== undefined) writeFileSync(join(dir, 'ROADMAP.md'), roadmap);
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "app",\n  "version": "0.1.0",\n  "scripts": { "test": "true" }\n}\n');
  writeFileSync(join(dir, 'CHANGELOG.md'), CHANGELOG);
  writeFileSync(join(dir, 'app.txt'), 'app\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '--quiet', '-m', 'init']);
}

/** A branch in a worktree of its own with one commit writing `file`. */
function branchWith(root: string, branch: string, file: string, text: string, from = 'main'): void {
  const dir = wt(branch, root);
  sh(root, ['worktree', 'add', '--quiet', '-b', branch, dir, from]);
  writeFileSync(join(dir, file), text);
  sh(dir, ['add', file]);
  sh(dir, ['commit', '--quiet', '-m', `${branch} work`]);
}

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-ship-')));
  repo = join(base, 'repo');
  hub = join(base, 'hub');
  sh(base, ['init', '--quiet', '--bare', '-b', 'main', 'origin.git']);
  makeRepo(repo, INITIAL_ROADMAP);
  mkdirSync(join(repo, 'app'));
  writeFileSync(join(repo, 'app', 'version.txt'), 'version 0.1.0\n');
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '--quiet', '-m', 'version file']);
  sh(repo, ['remote', 'add', 'origin', join(base, 'origin.git')]);
  sh(repo, ['push', '--quiet', '-u', 'origin', 'main']);
  sh(repo, ['remote', 'set-head', 'origin', 'main']);
  sh(base, ['clone', '--quiet', join(base, 'origin.git'), 'hub']);
  configure(hub);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('Ship (pr): the branch goes out on its own, the board stays home', () => {
  it('pushes the branch and opens its pull request without committing the board; Pull then finishes its cards', async () => {
    const A = 'worktree-0.2.0-card-a';
    sh(repo, ['worktree', 'add', '--quiet', '-b', A, wt('a'), 'main']);
    // Start Claude linked the card in the main checkout's board, which stays uncommitted.
    let text = change(linkCard(read(roadmapPath()), idOf(read(roadmapPath()), 'Card A'), A, 'doing'));
    writeFileSync(roadmapPath(), text);
    writeFileSync(join(wt('a'), 'app.txt'), 'app\nA\n');
    sh(wt('a'), ['commit', '--quiet', '-am', 'A work']);

    const cards = [{ text: 'Card A', lane: '0.2.0' }];
    const { gh, calls } = fakeGh();
    const shipped = await shipBranch({ repoRoot: repo, worktree: wt('a'), branch: A, base: 'main', title: prTitle(cards, 'A work'), body: prBody(cards, 'Did A.') }, gh);
    expect(shipped).toEqual({ ok: true, done: [`pushed ${A} to origin`, 'opened https://github.com/o/r/pull/1'], url: 'https://github.com/o/r/pull/1' });
    expect(calls).toEqual([['pr', 'create', '--base', 'main', '--head', A, '--title', 'Card A', '--body', 'Roadmap:\n\n- [x] Card A (0.2.0)\n\n## Report\n\nDid A.']]);
    // The branch carries its own commit only: the board on it is the one it started from.
    expect(sh(repo, ['log', '--format=%s', `origin/main..origin/${A}`]).trim()).toBe('A work');
    expect(sh(repo, ['show', `origin/${A}:ROADMAP.md`])).toBe(INITIAL_ROADMAP);
    expect(read(roadmapPath())).toBe(text);

    // GitHub squash-merges A; Pull finishes its cards in the board, then pulls. The board stays a local edit.
    merge(A, 'squash');
    text = finishMerged(read(roadmapPath()), { branches: [A], versions: [] });
    writeFileSync(roadmapPath(), text);
    expect(await pullDefault(repo)).toEqual({ ok: true, done: ['pulled'] });
    expect(read(join(repo, 'app.txt'))).toBe('app\nA\n');
    expect(status(repo)).toBe('M ROADMAP.md');
    expect(parseRoadmap(read(roadmapPath()))[0]?.items.map((i) => `${i.status}:${i.text}:${i.branch ?? ''}`)).toEqual(['done:Card A:', 'todo:Card B:']);
    sh(repo, ['checkout', '--', 'ROADMAP.md']);
  });

  it('ships a branch that has no worktree, from the main checkout', async () => {
    branchWith(repo, 'loose', 'loose.txt', 'loose\n');
    sh(repo, ['worktree', 'remove', wt('loose')]);
    const out = await shipBranch({ repoRoot: repo, branch: 'loose', base: 'main', title: 'Loose', body: '' }, fakeGh().gh);
    expect(out).toMatchObject({ ok: true, done: ['pushed loose to origin', 'opened https://github.com/o/r/pull/1'] });
    expect(sh(repo, ['rev-parse', 'origin/loose']).trim()).toBe(sh(repo, ['rev-parse', 'loose']).trim());
  });

  it('refuses a dirty worktree, and says what it left when the push or the pull request fails', async () => {
    const C = 'worktree-backlog-idea';
    sh(repo, ['worktree', 'add', '--quiet', '-b', C, wt('c'), 'main']);
    writeFileSync(join(wt('c'), 'c.txt'), 'C\n');
    const plan = { repoRoot: repo, worktree: wt('c'), branch: C, base: 'main', title: 'Idea', body: '' };
    const dirty = await shipBranch(plan, fakeGh().gh);
    expect(dirty).toMatchObject({ ok: false, done: [] });
    expect(dirty.error).toContain('uncommitted changes');
    sh(wt('c'), ['add', 'c.txt']);
    sh(wt('c'), ['commit', '--quiet', '-m', 'C work']);
    expect((await shipBranch({ ...plan, branch: 'other' }, fakeGh().gh)).error).toContain('no longer on other');

    sh(repo, ['remote', 'set-url', 'origin', join(base, 'nowhere.git')]);
    const noPush = await shipBranch(plan, fakeGh().gh);
    sh(repo, ['remote', 'set-url', 'origin', join(base, 'origin.git')]);
    expect(noPush).toMatchObject({ ok: false, done: [] });
    expect(noPush.error).toMatch(new RegExp(`^Pushing ${C} to origin failed: .*Nothing was pushed\\.$`));

    const noPr = await shipBranch(plan, fakeGh({}, failed('GraphQL: No commits between main and x')).gh);
    expect(noPr).toMatchObject({ ok: false, done: [`pushed ${C} to origin`] });
    expect(noPr.error).toBe(`The pull request was not opened: GraphQL: No commits between main and x. ${C} is on origin; Ship again, or open the pull request on GitHub.`);
    // Shipping again only opens the pull request: the branch is pushed already.
    expect((await shipBranch(plan, fakeGh().gh)).ok).toBe(true);
  });

  it('lists the pull requests of a branch, open first, through gh', async () => {
    const { gh, calls } = fakeGh({ x: [{ number: 2, state: 'MERGED', url: 'u2', mergeCommit: { oid: 'abc' } }, { number: 3, state: 'OPEN', url: 'u3', mergeCommit: null }] });
    expect(await prsFrom(gh, repo, 'x')).toEqual({ ok: true, prs: [{ number: 3, state: 'open', url: 'u3' }, { number: 2, state: 'merged', url: 'u2', mergeCommit: 'abc' }] });
    expect(calls).toEqual([['pr', 'list', '--head', 'x', '--state', 'all', '--limit', '10', '--json', 'number,state,url,mergeCommit']]);
    const missing: Gh = async () => ({ ok: false, stdout: '', stderr: '', code: 'ENOENT', timedOut: false });
    expect(await prsFrom(missing, repo, 'x')).toEqual({ ok: false, error: 'gh is not installed.' });
  });
});

describe('Release and Tag (pr)', () => {
  it('prepares the release pull request in a temporary worktree, without the board, then tags what merged', async () => {
    const head = sh(repo, ['rev-parse', 'HEAD']).trim();
    const drafted = await draftRelease({ repoRoot: repo, base: 'main', version: '0.2.0', versionFiles: ['app/version.txt'], date: '2026-11-14' });
    if (!drafted.ok) throw new Error(drafted.error);
    const files = Object.fromEntries(drafted.draft.files.map((f) => [f.path, f.text]));
    expect(Object.keys(files)).toEqual(['package.json', 'app/version.txt', 'CHANGELOG.md']);
    expect(files['package.json']).toBe('{\n  "name": "app",\n  "version": "0.2.0",\n  "scripts": { "test": "true" }\n}\n');
    expect(files['app/version.txt']).toBe('version 0.2.0\n');
    expect(files['CHANGELOG.md']).toBe('# Changelog\n\n## Unreleased\n\n## 0.2.0 - 2026-11-14\n\n- Card A\n- Card B\n\n## 0.1.0 - 2026-11-01\n\n- First\n');
    expect(drafted.draft.notes).toEqual(['Card A', 'Card B']);

    const lane = parseRoadmap(read(roadmapPath()))[0];
    if (!lane) throw new Error('no lane');
    const title = releaseTitle('0.2.0');
    const body = releaseBody(lane, drafted.draft.notes);
    const { gh, calls } = fakeGh();
    const opened = await openRelease(drafted.draft, title, body, gh);
    expect(opened).toEqual({ ok: true, done: ['committed package.json, app/version.txt, CHANGELOG.md on release-0.2.0', 'pushed release-0.2.0 to origin', 'opened https://github.com/o/r/pull/1'], url: 'https://github.com/o/r/pull/1' });
    expect(calls[0]?.slice(0, 7)).toEqual(['pr', 'create', '--base', 'main', '--head', 'release-0.2.0', '--title']);
    // The main checkout is untouched and the temporary worktree is gone.
    expect(sh(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(status(repo)).toBe('');
    expect(sh(repo, ['worktree', 'list', '--porcelain'])).not.toContain('cockpit-release-');
    expect(sh(repo, ['show', 'origin/release-0.2.0:package.json'])).toContain('"version": "0.2.0"');
    expect(sh(repo, ['show', 'origin/release-0.2.0:ROADMAP.md'])).toBe(sh(repo, ['show', 'origin/main:ROADMAP.md']));

    // Another release of the same version is refused while its branch exists.
    expect(await draftRelease({ repoRoot: repo, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-14' })).toMatchObject({ ok: false });

    // Not merged yet: no tag.
    expect(await findRelease(fakeGh({ 'release-0.2.0': [{ number: 9, state: 'OPEN', url: 'u', mergeCommit: null }] }).gh, repo, 'main', '0.2.0')).toMatchObject({ ok: false });

    const sha = merge('release-0.2.0', 'merge');
    expect((await pullDefault(repo)).ok).toBe(true);
    expect(status(repo)).toBe('');

    const merged = fakeGh({ 'release-0.2.0': [{ number: 9, state: 'MERGED', url: 'u', mergeCommit: { oid: sha } }] });
    expect(await findRelease(merged.gh, repo, 'main', '0.2.0')).toEqual({ ok: true, sha, pr: 9 });
    expect(await pushTag(repo, '0.2.0', sha)).toEqual({ ok: true, done: [`tagged ${sha.slice(0, 7)} v0.2.0`, 'pushed v0.2.0 to origin'] });
    // An annotated tag: a tag object pointing at the merge, with the release as its message.
    const hubGit = ['--git-dir', join(base, 'origin.git')];
    expect(sh(base, [...hubGit, 'cat-file', '-t', 'refs/tags/v0.2.0']).trim()).toBe('tag');
    expect(sh(base, [...hubGit, 'rev-parse', 'v0.2.0^{commit}']).trim()).toBe(sha);
    expect(sh(base, [...hubGit, 'tag', '-l', '--format=%(contents:subject)', 'v0.2.0']).trim()).toBe('Release 0.2.0');
    expect(await findRelease(merged.gh, repo, 'main', '0.2.0')).toEqual({ ok: false, error: 'v0.2.0 is already tagged in this repository.' });
    sh(repo, ['tag', '-d', 'v0.2.0']);
    expect(await findRelease(merged.gh, repo, 'main', '0.2.0')).toEqual({ ok: false, error: 'v0.2.0 is already tagged on origin.' });
  });

  it('refuses a release it cannot make, and deletes a tag it could not push', async () => {
    expect(await draftRelease({ repoRoot: repo, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-14' })).toMatchObject({ ok: false });
    expect(await draftRelease({ repoRoot: repo, base: 'main', version: '0.3.0', versionFiles: ['missing.txt'], date: '2026-11-14' })).toEqual({ ok: false, error: 'missing.txt (cockpit.release.versionFiles) is not in origin/main.' });
    // 0.2.0 left an empty Unreleased section behind, so the next release has one to date.
    expect(await draftRelease({ repoRoot: repo, base: 'main', version: '0.3.0', versionFiles: [], date: '2026-11-14' })).toMatchObject({ ok: true, draft: { notes: [] } });

    const sha = sh(repo, ['rev-parse', 'HEAD']).trim();
    sh(repo, ['remote', 'set-url', 'origin', join(base, 'nowhere.git')]);
    const out = await pushTag(repo, '0.3.0', sha);
    sh(repo, ['remote', 'set-url', 'origin', join(base, 'origin.git')]);
    expect(out.ok).toBe(false);
    expect(out.error).toContain('The local tag was deleted again.');
    expect(sh(repo, ['tag', '--list', 'v0.3.0']).trim()).toBe('');
  });
});

describe('pullDefault', () => {
  it('says so when the stashed changes conflict with what came in', async () => {
    writeFileSync(join(hub, 'app.txt'), 'app\nfrom GitHub\n');
    sh(hub, ['fetch', '--quiet', 'origin']);
    sh(hub, ['reset', '--quiet', '--hard', 'origin/main']);
    writeFileSync(join(hub, 'app.txt'), 'app\nA\nfrom GitHub\n');
    sh(hub, ['commit', '--quiet', '-am', 'remote change']);
    sh(hub, ['push', '--quiet', 'origin', 'main']);
    writeFileSync(join(repo, 'app.txt'), 'app\nA\nlocal change\n');
    const out = await pullDefault(repo);
    expect(out).toMatchObject({ ok: false, done: ['pulled'] });
    expect(out.error).toContain('safe in the stash');
    expect(existsSync(join(repo, 'app.txt'))).toBe(true);
  });
});

describe('Ship (direct): merged into the default branch in the main checkout', () => {
  let local: string;
  const tip = (dir: string, ref = 'HEAD') => sh(dir, ['rev-parse', ref]).trim();

  beforeAll(() => {
    local = join(base, 'direct');
    makeRepo(local);
  });

  it('fast-forwards when it can, else makes a merge commit', async () => {
    branchWith(local, 'ff', 'ff.txt', 'ff\n');
    expect(await mergeBranch({ repoRoot: local, branch: 'ff', base: 'main', push: false })).toEqual({ ok: true, done: ['fast-forwarded main to ff'] });
    expect(tip(local)).toBe(tip(local, 'ff'));

    branchWith(local, 'side', 'side.txt', 'side\n');
    writeFileSync(join(local, 'main.txt'), 'main\n');
    sh(local, ['add', 'main.txt']);
    sh(local, ['commit', '--quiet', '-m', 'on main']);
    expect(await mergeBranch({ repoRoot: local, branch: 'side', base: 'main', push: false })).toEqual({ ok: true, done: ['merged side into main'] });
    expect(sh(local, ['log', '-1', '--format=%P']).trim().split(' ')).toHaveLength(2);
    expect(status(local)).toBe('');
  });

  it('undoes a merge that conflicts, and leaves alone one git will not start', async () => {
    branchWith(local, 'clash', 'app.txt', 'app\nfrom the branch\n');
    writeFileSync(join(local, 'app.txt'), 'app\nfrom main\n');
    sh(local, ['commit', '--quiet', '-am', 'main edits app']);
    const before = tip(local);
    const out = await mergeBranch({ repoRoot: local, branch: 'clash', base: 'main', push: false });
    expect(out).toEqual({ ok: false, done: [], error: 'Merging clash into main failed: it conflicts in app.txt. The merge was undone: main is as it was.' });
    expect(tip(local)).toBe(before);
    expect(status(local)).toBe('');

    // Uncommitted changes in a file the merge touches: git refuses to start, and there is nothing to undo.
    branchWith(local, 'touch', 'main.txt', 'main\nbranch\n');
    writeFileSync(join(local, 'main.txt'), 'main\nuncommitted\n');
    const refused = await mergeBranch({ repoRoot: local, branch: 'touch', base: 'main', push: false });
    expect(refused).toMatchObject({ ok: false, done: [] });
    expect(refused.error).toMatch(/^Merging touch into main failed: .*Nothing was changed\.$/);
    expect(read(join(local, 'main.txt'))).toBe('main\nuncommitted\n');
    sh(local, ['checkout', '--', 'main.txt']);
  });

  it('refuses when the main checkout is not on the default branch, or the branch is gone', async () => {
    sh(local, ['checkout', '--quiet', '-b', 'elsewhere']);
    expect(await mergeBranch({ repoRoot: local, branch: 'touch', base: 'main', push: false })).toEqual({
      ok: false,
      done: [],
      error: `The main checkout (${local}) is not on main: switch it to main first.`,
    });
    sh(local, ['checkout', '--quiet', 'main']);
    expect(await mergeBranch({ repoRoot: local, branch: 'nope', base: 'main', push: false })).toEqual({ ok: false, done: [], error: 'nope is not a branch here.' });
  });

  it('pushes the default branch after the merge when asked, and says the merge is local when the push fails', async () => {
    const pushing = join(base, 'direct-origin');
    makeRepo(pushing);
    sh(base, ['init', '--quiet', '--bare', '-b', 'main', 'direct-origin.git']);
    sh(pushing, ['remote', 'add', 'origin', join(base, 'direct-origin.git')]);
    sh(pushing, ['push', '--quiet', '-u', 'origin', 'main']);
    branchWith(pushing, 'feat', 'feat.txt', 'feat\n');
    expect(await mergeBranch({ repoRoot: pushing, branch: 'feat', base: 'main', push: true })).toEqual({ ok: true, done: ['fast-forwarded main to feat', 'pushed main to origin'] });
    expect(sh(pushing, ['ls-remote', 'origin', 'refs/heads/main']).split('\t')[0]).toBe(tip(pushing));

    branchWith(pushing, 'feat2', 'feat2.txt', 'feat2\n');
    sh(pushing, ['remote', 'set-url', 'origin', join(base, 'nowhere.git')]);
    const out = await mergeBranch({ repoRoot: pushing, branch: 'feat2', base: 'main', push: true });
    sh(pushing, ['remote', 'set-url', 'origin', join(base, 'direct-origin.git')]);
    expect(out).toMatchObject({ ok: false, done: ['fast-forwarded main to feat2'] });
    expect(out.error).toMatch(/^Pushing main to origin failed: .*The merge is in your local main only\.$/);
  });
});

describe('Release and Tag (direct): a commit and a tag on the default branch', () => {
  let local: string;
  const BOARD = '# Roadmap\n\n## 0.2.0\n\n- [x] Card A\n- [x] Card B\n\n## Backlog\n';

  beforeAll(() => {
    local = join(base, 'direct-release');
    makeRepo(local, BOARD);
  });

  it('commits only its files, the tracked board shipped with them, and tags that commit', async () => {
    // Work in progress that is not the release's: it stays uncommitted.
    writeFileSync(join(local, 'app.txt'), 'app\nwork in progress\n');
    const drafted = await draftDirect({ repoRoot: local, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-14', remote: false });
    if (!drafted.ok) throw new Error(drafted.error);
    expect(drafted.draft.files.map((f) => [f.path, f.change])).toEqual([
      ['package.json', '0.1.0 → 0.2.0'],
      ['CHANGELOG.md', '"## Unreleased" → "## 0.2.0 - 2026-11-14"'],
    ]);
    expect(drafted.draft.notes).toEqual(['Card A', 'Card B']);
    expect(await isTracked(local, 'ROADMAP.md')).toBe(true);
    const shipped = change(setLaneStatus(read(join(local, 'ROADMAP.md')), '0.2.0', 'shipped'));

    const out = await commitRelease(drafted.draft, { roadmap: { path: 'ROADMAP.md', text: shipped }, push: false });
    expect(out).toEqual({ ok: true, done: ['committed package.json, CHANGELOG.md, ROADMAP.md on main as "Release 0.2.0"', 'tagged it v0.2.0'] });
    expect(sh(local, ['log', '-1', '--format=%s']).trim()).toBe('Release 0.2.0');
    expect(sh(local, ['show', '--name-only', '--format=', 'HEAD']).trim().split('\n').sort()).toEqual(['CHANGELOG.md', 'ROADMAP.md', 'package.json']);
    expect(sh(local, ['show', 'HEAD:ROADMAP.md'])).toBe(shipped);
    expect(sh(local, ['cat-file', '-t', 'refs/tags/v0.2.0']).trim()).toBe('tag');
    expect(sh(local, ['rev-parse', 'v0.2.0^{commit}']).trim()).toBe(sh(local, ['rev-parse', 'HEAD']).trim());
    expect(status(local)).toBe('M app.txt');
    sh(local, ['checkout', '--', 'app.txt']);

    // The tag is taken now.
    expect(await draftDirect({ repoRoot: local, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-14', remote: false })).toEqual({ ok: false, error: 'v0.2.0 is already tagged in this repository.' });
  });

  it('brings package-lock.json to the new version along with package.json, even when it was left behind', async () => {
    const dir = join(base, 'direct-lockfile');
    makeRepo(dir);
    const lock = (v: string) => `{\n  "name": "app",\n  "version": "${v}",\n  "lockfileVersion": 3,\n  "packages": {\n    "": {\n      "name": "app",\n      "version": "${v}"\n    }\n  }\n}\n`;
    writeFileSync(join(dir, 'package-lock.json'), lock('0.0.9'));
    sh(dir, ['add', '.']);
    sh(dir, ['commit', '--quiet', '-m', 'lockfile']);
    const drafted = await draftDirect({ repoRoot: dir, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-14', remote: false });
    if (!drafted.ok) throw new Error(drafted.error);
    expect(drafted.draft.files.map((f) => [f.path, f.change])).toEqual([
      ['package.json', '0.1.0 → 0.2.0'],
      ['package-lock.json', '→ 0.2.0'],
      ['CHANGELOG.md', '"## Unreleased" → "## 0.2.0 - 2026-11-14"'],
    ]);
    expect(drafted.draft.files.find((f) => f.path === 'package-lock.json')?.text).toBe(lock('0.2.0'));
  });

  it('refuses a file it changes that has uncommitted changes, and puts the files back when the commit fails', async () => {
    writeFileSync(join(local, 'CHANGELOG.md'), `${read(join(local, 'CHANGELOG.md'))}\n- typed by hand\n`);
    expect(await draftDirect({ repoRoot: local, base: 'main', version: '0.3.0', versionFiles: [], date: '2026-11-14', remote: false })).toEqual({
      ok: false,
      error: 'CHANGELOG.md has uncommitted changes: commit them first. The release commit holds its own edits only.',
    });
    sh(local, ['checkout', '--', 'CHANGELOG.md']);

    const drafted = await draftDirect({ repoRoot: local, base: 'main', version: '0.3.0', versionFiles: [], date: '2026-11-14', remote: false });
    if (!drafted.ok) throw new Error(drafted.error);
    const hooks = join(base, 'failing-hooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    sh(local, ['config', 'core.hooksPath', hooks]);
    const pkg = read(join(local, 'package.json'));
    const out = await commitRelease(drafted.draft, { push: false });
    sh(local, ['config', 'core.hooksPath', '/dev/null']);
    expect(out).toMatchObject({ ok: false, done: [] });
    expect(out.error).toMatch(/^Could not commit the release: .*The files are as they were\.$/);
    expect(read(join(local, 'package.json'))).toBe(pkg);
    expect(status(local)).toBe('');
    expect(sh(local, ['tag', '--list', 'v0.3.0']).trim()).toBe('');
  });

  it('leaves an untracked board out of the commit, and refuses a release whose base moved', async () => {
    await ensureCockpitDir(local);
    writeFileSync(join(local, '.cockpit', 'roadmap.md'), '## 0.3.0\n\n- [x] C\n');
    expect(await isTracked(local, '.cockpit/roadmap.md')).toBe(false);
    expect(status(local)).toBe('');

    const drafted = await draftDirect({ repoRoot: local, base: 'main', version: '0.3.0', versionFiles: [], date: '2026-11-15', remote: false });
    if (!drafted.ok) throw new Error(drafted.error);
    writeFileSync(join(local, 'later.txt'), 'later\n');
    sh(local, ['add', 'later.txt']);
    sh(local, ['commit', '--quiet', '-m', 'later']);
    expect(await commitRelease(drafted.draft, { push: false })).toEqual({ ok: false, done: [], error: 'main moved since the release was prepared: release again.' });

    const again = await draftDirect({ repoRoot: local, base: 'main', version: '0.3.0', versionFiles: [], date: '2026-11-15', remote: false });
    if (!again.ok) throw new Error(again.error);
    expect(await commitRelease(again.draft, { push: false })).toEqual({ ok: true, done: ['committed package.json, CHANGELOG.md on main as "Release 0.3.0"', 'tagged it v0.3.0'] });
    expect(read(join(local, '.cockpit', 'roadmap.md'))).toBe('## 0.3.0\n\n- [x] C\n');
  });

  it.each(['changelog edit', 'manifest edit', 'deleted file', 'new lockfile', 'staged edit', 'staged deletion'])('preserves %s made after preparation and refuses the stale release', async (scenario) => {
    const dir = join(base, `release-race-${scenario.replace(/ /g, '-')}`);
    makeRepo(dir);
    const drafted = await draftDirect({ repoRoot: dir, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-16', remote: false });
    if (!drafted.ok) throw new Error(drafted.error);
    const pkg = read(join(dir, 'package.json'));
    const changelog = read(join(dir, 'CHANGELOG.md'));
    if (scenario === 'changelog edit') writeFileSync(join(dir, 'CHANGELOG.md'), `${changelog}\n- Added while confirmation open\n`);
    if (scenario === 'manifest edit') writeFileSync(join(dir, 'package.json'), pkg.replace('"name": "app"', '"name": "new name"'));
    if (scenario === 'deleted file') rmSync(join(dir, 'CHANGELOG.md'));
    if (scenario === 'new lockfile') writeFileSync(join(dir, 'package-lock.json'), '{"version":"0.1.0","lockfileVersion":3}\n');
    if (scenario === 'staged edit') {
      writeFileSync(join(dir, 'CHANGELOG.md'), `${changelog}\n- Staged while confirmation open\n`);
      sh(dir, ['add', 'CHANGELOG.md']);
      // Even when the working file has its original bytes, the user's staged edit must survive.
      writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    }
    if (scenario === 'staged deletion') {
      sh(dir, ['rm', '--quiet', 'CHANGELOG.md']);
      writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    }
    const paths = ['package.json', 'CHANGELOG.md', 'package-lock.json'];
    const beforeFiles = paths.map((p) => existsSync(join(dir, p)) ? read(join(dir, p)) : undefined);
    const beforeStatus = status(dir);
    const beforeIndex = sh(dir, ['ls-files', '--stage', '-z']);
    const beforeHead = sh(dir, ['rev-parse', 'HEAD']);

    const out = await commitRelease(drafted.draft, { push: false });
    expect(out).toMatchObject({ ok: false, done: [] });
    expect(out.error).toMatch(/since the release was prepared.*Nothing was overwritten/);
    expect(paths.map((p) => existsSync(join(dir, p)) ? read(join(dir, p)) : undefined)).toEqual(beforeFiles);
    expect(sh(dir, ['ls-files', '--stage', '-z'])).toBe(beforeIndex);
    expect(status(dir)).toBe(beforeStatus);
    expect(sh(dir, ['rev-parse', 'HEAD'])).toBe(beforeHead);
    expect(sh(dir, ['tag', '--list', 'v0.2.0']).trim()).toBe('');
    expect(existsSync(join(dir, '.git', 'cockpit-release.lock'))).toBe(false);
  });

  it('rechecks the board snapshot inside the release lock', async () => {
    const dir = join(base, 'release-board-race');
    makeRepo(dir, BOARD);
    const drafted = await draftDirect({ repoRoot: dir, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-16', remote: false });
    if (!drafted.ok) throw new Error(drafted.error);
    const newer = `${BOARD}\n- [ ] Added during confirmation\n`;
    writeFileSync(join(dir, 'ROADMAP.md'), newer);
    const out = await commitRelease(drafted.draft, { roadmap: { path: 'ROADMAP.md', text: change(setLaneStatus(BOARD, '0.2.0', 'shipped')), originalText: BOARD }, push: false });
    expect(out).toEqual({ ok: false, done: [], error: 'ROADMAP.md changed since the release was prepared: release again. Nothing was overwritten.' });
    expect(read(join(dir, 'ROADMAP.md'))).toBe(newer);
    expect(read(join(dir, 'package.json'))).toContain('"version": "0.1.0"');
    expect(sh(dir, ['tag', '--list', 'v0.2.0']).trim()).toBe('');
  });

  it('allows only one concurrent direct release to mutate the repository', async () => {
    const dir = join(base, 'release-concurrent');
    makeRepo(dir);
    const drafted = await draftDirect({ repoRoot: dir, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-16', remote: false });
    if (!drafted.ok) throw new Error(drafted.error);
    const results = await Promise.all([commitRelease(drafted.draft, { push: false }), commitRelease(drafted.draft, { push: false })]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toHaveLength(1);
    expect(sh(dir, ['rev-list', '--count', 'HEAD']).trim()).toBe('2');
    expect(sh(dir, ['rev-parse', 'v0.2.0^{commit}'])).toBe(sh(dir, ['rev-parse', 'HEAD']));
    expect(status(dir)).toBe('');
    expect(existsSync(join(dir, '.git', 'cockpit-release.lock'))).toBe(false);
  });

  it('keeps newer edits made by a failing commit hook rather than rolling them back', async () => {
    const dir = join(base, 'release-hook-edit');
    makeRepo(dir);
    const drafted = await draftDirect({ repoRoot: dir, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-16', remote: false });
    if (!drafted.ok) throw new Error(drafted.error);
    const hooks = join(dir, '.git', 'hooks');
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nprintf "\\n- Newer hook edit\\n" >> CHANGELOG.md\nexit 1\n', { mode: 0o755 });
    sh(dir, ['config', 'core.hooksPath', hooks]);
    const out = await commitRelease(drafted.draft, { push: false });
    expect(out).toMatchObject({ ok: false, done: [] });
    expect(out.error).toContain('Newer file edits were kept');
    expect(read(join(dir, 'CHANGELOG.md'))).toContain('- Newer hook edit');
    expect(read(join(dir, 'package.json'))).toContain('"version": "0.1.0"');
    expect(sh(dir, ['tag', '--list', 'v0.2.0']).trim()).toBe('');
    expect(existsSync(join(dir, '.git', 'cockpit-release.lock'))).toBe(false);
  });

  it('tags the default branch tip for a shipped lane, here only or pushed too', async () => {
    const found = await findDirectTag(local, 'main', '0.3.1', false);
    expect(found).toEqual({ ok: true, sha: sh(local, ['rev-parse', 'main']).trim() });
    if (!found.ok) return;
    expect(await pushTag(local, '0.3.1', found.sha, false)).toEqual({ ok: true, done: [`tagged ${found.sha.slice(0, 7)} v0.3.1`] });
    expect(await findDirectTag(local, 'main', '0.3.1', false)).toEqual({ ok: false, error: 'v0.3.1 is already tagged in this repository.' });
  });

  it('pushes the release commit and its tag together when there is an origin', async () => {
    const pushing = join(base, 'direct-release-origin');
    makeRepo(pushing);
    sh(base, ['init', '--quiet', '--bare', '-b', 'main', 'direct-release-origin.git']);
    sh(pushing, ['remote', 'add', 'origin', join(base, 'direct-release-origin.git')]);
    sh(pushing, ['push', '--quiet', '-u', 'origin', 'main']);
    const drafted = await draftDirect({ repoRoot: pushing, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-14', remote: true });
    if (!drafted.ok) throw new Error(drafted.error);
    expect(await commitRelease(drafted.draft, { push: true })).toEqual({
      ok: true,
      done: ['committed package.json, CHANGELOG.md on main as "Release 0.2.0"', 'tagged it v0.2.0', 'pushed main and v0.2.0 to origin'],
    });
    const remote = sh(pushing, ['ls-remote', 'origin']);
    expect(remote).toContain('refs/heads/main');
    expect(remote).toContain('refs/tags/v0.2.0');
    // A tag on origin only is taken too.
    sh(pushing, ['tag', '-d', 'v0.2.0']);
    expect(await findDirectTag(pushing, 'main', '0.2.0', true)).toEqual({ ok: false, error: 'v0.2.0 is already tagged on origin.' });
  });
});
