// Ship, Release, Tag and Pull end to end against a real repository whose remote is a local bare one, with a second
// clone standing in for GitHub's merge button. gh is replaced by a function that records what it was asked and
// answers like gh does; nothing leaves the machine.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyRoadmapEdit, boardChanges, finishBranch, finishMerged, linkCard, parseRoadmap, setLaneStatus } from '../src/data/roadmap';
import type { RunResult } from '../src/data/git';
import { prBody, prTitle, releaseBody, releaseTitle, roadmapCommitMessage } from '../src/publish';
import { baseRoadmap, draftRelease, findRelease, type Gh, openRelease, prsFrom, pullDefault, pushTag, shipBranch } from '../src/ship';

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
};
const read = (path: string) => readFileSync(path, 'utf8');
const status = (dir: string) => sh(dir, ['status', '--porcelain']).trim();
const wt = (name: string) => join(repo, '.claude', 'worktrees', name);
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

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-ship-')));
  repo = join(base, 'repo');
  hub = join(base, 'hub');
  sh(base, ['init', '--quiet', '--bare', '-b', 'main', 'origin.git']);
  mkdirSync(repo);
  sh(repo, ['init', '--quiet', '-b', 'main']);
  configure(repo);
  writeFileSync(join(repo, '.gitignore'), '.claude/\n');
  writeFileSync(join(repo, 'ROADMAP.md'), '# Roadmap\n\n## 0.2.0\n\n- [ ] Card A\n- [ ] Card B\n\n## Backlog\n\n- [ ] Idea\n');
  writeFileSync(join(repo, 'package.json'), '{\n  "name": "app",\n  "version": "0.1.0",\n  "scripts": { "test": "true" }\n}\n');
  mkdirSync(join(repo, 'app'));
  writeFileSync(join(repo, 'app', 'version.txt'), 'version 0.1.0\n');
  writeFileSync(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- Card A\n- Card B\n\n## 0.1.0 - 2026-11-01\n\n- First\n');
  writeFileSync(join(repo, 'app.txt'), 'app\n');
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '--quiet', '-m', 'init']);
  sh(repo, ['remote', 'add', 'origin', join(base, 'origin.git')]);
  sh(repo, ['push', '--quiet', '-u', 'origin', 'main']);
  sh(repo, ['remote', 'set-head', 'origin', 'main']);
  sh(base, ['clone', '--quiet', join(base, 'origin.git'), 'hub']);
  configure(hub);
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('Ship: the roadmap travels in the pull request', () => {
  it('ships two branches started together; each merges cleanly and the pull after it leaves ROADMAP.md clean', async () => {
    const A = 'worktree-0.2.0-card-a';
    const B = 'worktree-0.2.0-card-b';
    sh(repo, ['worktree', 'add', '--quiet', '-b', A, wt('a'), 'main']);
    sh(repo, ['worktree', 'add', '--quiet', '-b', B, wt('b'), 'main']);
    // Start Claude linked both cards in the main checkout's working file, which stays uncommitted.
    let text = read(roadmapPath());
    text = change(linkCard(text, idOf(text, 'Card A'), A, 'doing'));
    text = change(linkCard(text, idOf(text, 'Card B'), B, 'doing'));
    text = change(applyRoadmapEdit(text, { op: 'addRelease', version: '0.3.0' }));
    writeFileSync(roadmapPath(), text);
    writeFileSync(join(wt('a'), 'app.txt'), 'app\nA\n');
    sh(wt('a'), ['commit', '--quiet', '-am', 'A work']);
    writeFileSync(join(wt('b'), 'b.txt'), 'B\n');
    sh(wt('b'), ['add', 'b.txt']);
    sh(wt('b'), ['commit', '--quiet', '-m', 'B work']);

    // Ship A.
    const cardsA = [{ text: 'Card A', lane: '0.2.0' }];
    const planA = { worktree: wt('a'), branch: A, base: 'main', roadmap: finishBranch(text, A), commitMessage: roadmapCommitMessage(cardsA), title: prTitle(cardsA, 'A work'), body: prBody(cardsA, 'Did A.\n\nStill open:\n- a token') };
    const ghA = fakeGh();
    const shipped = await shipBranch(planA, ghA.gh);
    expect(shipped).toEqual({ ok: true, done: [`committed ROADMAP.md on ${A}`, `pushed ${A} to origin`, 'opened https://github.com/o/r/pull/1'], url: 'https://github.com/o/r/pull/1' });
    expect(ghA.calls).toEqual([['pr', 'create', '--base', 'main', '--head', A, '--title', 'Card A', '--body', 'Roadmap:\n\n- [x] Card A (0.2.0)\n\n## Report\n\nDid A.\n\nStill open:\n- a token']]);
    expect(sh(repo, ['show', `origin/${A}:ROADMAP.md`])).toBe(planA.roadmap);
    expect(sh(repo, ['log', '-1', '--format=%s', `origin/${A}`]).trim()).toBe('Roadmap: Card A done');
    // While the pull request is open, main's working file keeps the card in progress with its link.
    expect(read(roadmapPath())).toBe(text);

    // GitHub squash-merges A. Until Pull, main's working file stays as it was (the board only shows A's cards done);
    // Pull first finishes A's cards in it, then pulls.
    merge(A, 'squash');
    expect(read(roadmapPath())).toBe(text);
    text = finishMerged(read(roadmapPath()), { branches: [A], versions: [] });
    writeFileSync(roadmapPath(), text);
    expect(await pullDefault(repo)).toEqual({ ok: true, done: ['pulled'] });
    expect(status(repo)).toBe('');

    // A board edit while B works, then Ship B: main's ROADMAP.md moved since B started, so B merges main first.
    text = change(applyRoadmapEdit(read(roadmapPath()), { op: 'add', lane: 'Backlog', text: 'Later idea' }));
    writeFileSync(roadmapPath(), text);
    const cardsB = [{ text: 'Card B', lane: '0.2.0' }];
    // What Ship's confirmation lists besides B's own card: the board edit, against main on the remote.
    expect(boardChanges((await baseRoadmap(repo, 'main')) ?? '', finishBranch(text, B), ['Card B'])).toEqual(['added "Later idea" (Backlog, planned)']);
    const shippedB = await shipBranch({ worktree: wt('b'), branch: B, base: 'main', roadmap: finishBranch(text, B), commitMessage: roadmapCommitMessage(cardsB), title: prTitle(cardsB, ''), body: prBody(cardsB, undefined) }, fakeGh().gh);
    expect(shippedB.done).toEqual([`merged origin/main into ${B}`, `committed ROADMAP.md on ${B}`, `pushed ${B} to origin`, 'opened https://github.com/o/r/pull/1']);
    merge(B, 'merge');
    writeFileSync(roadmapPath(), finishMerged(read(roadmapPath()), { branches: [B], versions: [] }));
    expect((await pullDefault(repo)).ok).toBe(true);
    expect(status(repo)).toBe('');
    expect(parseRoadmap(read(roadmapPath())).map((l) => [l.version, ...l.items.map((i) => `${i.status}:${i.text}:${i.branch ?? ''}`)])).toEqual([
      ['0.2.0', 'done:Card A:', 'done:Card B:'],
      ['0.3.0'],
      ['Backlog', 'todo:Idea:', 'todo:Later idea:'],
    ]);
    expect(await pullDefault(repo)).toEqual({ ok: true, done: ['already up to date'] });
  });

  it('refuses a dirty worktree, and says what it left when the push or the pull request fails', async () => {
    const C = 'worktree-backlog-idea';
    sh(repo, ['worktree', 'add', '--quiet', '-b', C, wt('c'), 'main']);
    writeFileSync(join(wt('c'), 'c.txt'), 'C\n');
    const plan = { worktree: wt('c'), branch: C, base: 'main', commitMessage: 'Roadmap: Idea done', title: 'Idea', body: '' };
    const dirty = await shipBranch(plan, fakeGh().gh);
    expect(dirty).toMatchObject({ ok: false, done: [] });
    expect(dirty.error).toContain('uncommitted changes');
    sh(wt('c'), ['add', 'c.txt']);
    sh(wt('c'), ['commit', '--quiet', '-m', 'C work']);
    expect((await shipBranch({ ...plan, branch: 'other' }, fakeGh().gh)).error).toContain('no longer on other');

    const roadmap = finishBranch(read(roadmapPath()), C);
    sh(repo, ['remote', 'set-url', 'origin', join(base, 'nowhere.git')]);
    const noPush = await shipBranch({ ...plan, roadmap }, fakeGh().gh);
    expect(noPush.ok).toBe(false);
    expect(noPush.error).toContain('Could not fetch main');
    sh(repo, ['remote', 'set-url', 'origin', join(base, 'origin.git')]);

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

describe('Release and Tag', () => {
  it('prepares the release pull request in a temporary worktree, then tags what merged', async () => {
    const head = sh(repo, ['rev-parse', 'HEAD']).trim();
    const working = read(roadmapPath());
    const roadmap = change(setLaneStatus(working, '0.2.0', 'shipped'));
    const drafted = await draftRelease({ repoRoot: repo, base: 'main', version: '0.2.0', versionFiles: ['app/version.txt'], roadmap, date: '2026-11-14' });
    if (!drafted.ok) throw new Error(drafted.error);
    const files = Object.fromEntries(drafted.draft.files.map((f) => [f.path, f.text]));
    expect(Object.keys(files)).toEqual(['package.json', 'app/version.txt', 'CHANGELOG.md', 'ROADMAP.md']);
    expect(files['package.json']).toBe('{\n  "name": "app",\n  "version": "0.2.0",\n  "scripts": { "test": "true" }\n}\n');
    expect(files['app/version.txt']).toBe('version 0.2.0\n');
    expect(files['CHANGELOG.md']).toBe('# Changelog\n\n## Unreleased\n\n## 0.2.0 - 2026-11-14\n\n- Card A\n- Card B\n\n## 0.1.0 - 2026-11-01\n\n- First\n');
    expect(drafted.draft.notes).toEqual(['Card A', 'Card B']);

    const lane = parseRoadmap(roadmap)[0];
    if (!lane) throw new Error('no lane');
    const title = releaseTitle('0.2.0');
    const body = releaseBody(lane, drafted.draft.notes);
    const { gh, calls } = fakeGh();
    const opened = await openRelease(drafted.draft, title, body, gh);
    expect(opened).toEqual({ ok: true, done: ['committed package.json, app/version.txt, CHANGELOG.md, ROADMAP.md on release-0.2.0', 'pushed release-0.2.0 to origin', 'opened https://github.com/o/r/pull/1'], url: 'https://github.com/o/r/pull/1' });
    expect(calls).toEqual([['pr', 'create', '--base', 'main', '--head', 'release-0.2.0', '--title', 'Release 0.2.0', '--body', '## Changelog\n\n- Card A\n- Card B\n\n## Roadmap\n\n- [x] Card A\n- [x] Card B']]);
    // The main checkout is untouched and the temporary worktree is gone.
    expect(sh(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(read(roadmapPath())).toBe(working);
    expect(sh(repo, ['worktree', 'list', '--porcelain'])).not.toContain('cockpit-release-');
    expect(sh(repo, ['show', 'origin/release-0.2.0:package.json'])).toContain('"version": "0.2.0"');

    // Another release of the same version is refused while its branch exists.
    expect(await draftRelease({ repoRoot: repo, base: 'main', version: '0.2.0', versionFiles: [], date: '2026-11-14' })).toMatchObject({ ok: false });

    // Not merged yet: no tag.
    expect(await findRelease(fakeGh({ 'release-0.2.0': [{ number: 9, state: 'OPEN', url: 'u', mergeCommit: null }] }).gh, repo, 'main', '0.2.0')).toMatchObject({ ok: false });

    const sha = merge('release-0.2.0', 'merge');
    // Pull marks the merged release shipped in main's working file, as the merge has it, then pulls.
    writeFileSync(roadmapPath(), finishMerged(read(roadmapPath()), { branches: [], versions: ['0.2.0'] }));
    expect(read(roadmapPath())).toBe(roadmap);
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
