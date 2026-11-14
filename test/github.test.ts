import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ghNote, parsePullRequests, parseRuns, readGithub, runStatus, summarizeChecks } from '../src/data/github';
import { loadGithub } from '../src/sources';

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures/github', name), 'utf8');

describe('parsePullRequests', () => {
  const prs = parsePullRequests(fixture('pr-list.json'));

  it('keeps valid entries, drops one without a number', () => {
    expect(prs.map((p) => p.number)).toEqual([14, 13, 12, 11, 10]);
  });

  it('maps state, draft, review decision and time', () => {
    expect(prs[0]).toEqual({
      number: 14,
      title: 'Search: filters by city and price',
      url: 'https://github.com/acme/shop/pull/14',
      branch: 'search-filters',
      isDraft: false,
      state: 'open',
      reviewDecision: 'changes_requested',
      checks: { state: 'failure', url: 'https://github.com/acme/shop/actions/runs/9000000001/job/9100000002' },
      updatedAt: Date.parse('2026-11-12T10:12:43Z'),
    });
    expect(prs[1]).toMatchObject({ isDraft: true, state: 'open' });
    expect(prs[1]?.reviewDecision).toBeUndefined();
    expect(prs[2]).toMatchObject({ state: 'merged', reviewDecision: 'approved' });
    expect(prs[3]).toMatchObject({ state: 'closed', reviewDecision: 'review_required' });
    expect(prs[4]?.reviewDecision).toBeUndefined();
  });

  it('summarizes checks: failure, pending (CheckRun and StatusContext), success with neutral/skipped, none', () => {
    expect(prs.map((p) => p.checks.state)).toEqual(['failure', 'pending', 'success', 'pending', 'none']);
    expect(prs[1]?.checks.url).toBe('https://github.com/acme/shop/actions/runs/9000000002/job/9100000012');
    expect(summarizeChecks(undefined)).toEqual({ state: 'none' });
    expect(summarizeChecks([{ __typename: 'StatusContext', state: 'ERROR' }])).toEqual({ state: 'failure' });
  });

  it('tolerates junk', () => {
    expect(parsePullRequests('not json')).toEqual([]);
    expect(parsePullRequests('{"a":1}')).toEqual([]);
  });
});

describe('parseRuns', () => {
  const runs = parseRuns(fixture('run-list.json'));

  it('maps status and conclusion', () => {
    expect(runs.map((r) => [r.id, r.status])).toEqual([
      [9000000010, 'in_progress'],
      [9000000009, 'success'],
      [9000000008, 'failure'],
      [9000000007, 'cancelled'],
      [9000000006, 'queued'],
      [9000000005, 'other'],
    ]);
    expect(runStatus('waiting', '')).toBe('queued');
    expect(runStatus('completed', 'timed_out')).toBe('failure');
    expect(runStatus('something-new', undefined)).toBe('other');
  });

  it('computes duration only for finished runs and ignores the zero date', () => {
    expect(runs[0]?.durationMs).toBeUndefined();
    expect(runs[1]).toMatchObject({
      title: 'Checkout: show the fee before the last step',
      workflow: 'CI',
      branch: 'main',
      url: 'https://github.com/acme/shop/actions/runs/9000000009',
      startedAt: Date.parse('2026-11-12T15:28:59Z'),
      durationMs: Date.parse('2026-11-12T15:52:56Z') - Date.parse('2026-11-12T15:28:59Z'),
    });
    // startedAt 0001-01-01 falls back to createdAt.
    expect(runs[4]?.startedAt).toBe(Date.parse('2026-11-11T07:00:00Z'));
  });
});

describe('ghNote', () => {
  const note = (stderr: string, code?: number | string, timedOut = false) => ghNote({ stderr, code, timedOut });
  it('names the usual reasons in a few words', () => {
    expect(note('', 'ENOENT')).toBe('gh not installed');
    expect(note('To get started with GitHub CLI, please run:  gh auth login\n', 4)).toBe('gh not logged in');
    expect(note('no git remotes found\n', 1)).toBe('no GitHub remote');
    expect(
      note('none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`\n', 1),
    ).toBe('no GitHub remote');
    expect(note('Post "https://api.github.com/graphql": dial tcp: lookup api.github.com: no such host\n', 1)).toBe('GitHub unreachable (offline?)');
    expect(note('', undefined, true)).toBe('GitHub unreachable (timed out)');
    expect(note('failed to run git: fatal: not a git repository (or any of the parent directories): .git\n', 1)).toBe('not a git repository');
    expect(note('HTTP 502: Bad Gateway\n', 1)).toBe('gh failed: HTTP 502: Bad Gateway');
  });
});

// readGithub against a stand-in gh on PATH: the real one would need the network and a login.
describe('readGithub', () => {
  let base: string;
  let path: string | undefined;
  const fakeGh = (script: string) => {
    writeFileSync(join(base, 'bin', 'gh'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(base, 'bin', 'gh'), 0o755);
  };

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'cockpit-gh-'));
    mkdirSync(join(base, 'bin'));
    writeFileSync(join(base, 'pr.json'), fixture('pr-list.json'));
    writeFileSync(join(base, 'run.json'), fixture('run-list.json'));
    path = process.env.PATH;
  });
  afterAll(() => {
    process.env.PATH = path;
    rmSync(base, { recursive: true, force: true });
  });

  it('returns the repository, PRs and runs', async () => {
    fakeGh(`case "$1" in repo) echo '{"nameWithOwner":"acme/shop"}';; pr) cat "${base}/pr.json";; run) cat "${base}/run.json";; esac`);
    process.env.PATH = `${join(base, 'bin')}:${path ?? ''}`;
    const r = await readGithub(base);
    expect(r.github).toBe('acme/shop');
    expect(r.githubNote).toBeUndefined();
    expect(r.prs).toHaveLength(5);
    expect(r.ciRuns).toHaveLength(6);
  });

  it('keeps what worked when one call fails', async () => {
    fakeGh(`case "$1" in repo) echo '{"nameWithOwner":"acme/shop"}';; pr) cat "${base}/pr.json";; run) echo 'HTTP 502: Bad Gateway' >&2; exit 1;; esac`);
    process.env.PATH = `${join(base, 'bin')}:${path ?? ''}`;
    const r = await readGithub(base);
    expect(r).toMatchObject({ github: 'acme/shop', githubNote: 'gh failed: HTTP 502: Bad Gateway' });
    expect(r.prs).toHaveLength(5);
    // Not an empty list: a list gh could not read, which the store fills with the last one it had.
    expect(r.ciRuns).toBeUndefined();
  });

  it('logged out: no lists and a note', async () => {
    fakeGh(`echo 'To get started with GitHub CLI, please run:  gh auth login' >&2; exit 4`);
    process.env.PATH = `${join(base, 'bin')}:${path ?? ''}`;
    expect(await readGithub(base)).toEqual({ githubNote: 'gh not logged in' });
  });

  it('gh missing: no lists and a note', async () => {
    process.env.PATH = join(base, 'empty');
    expect(await readGithub(base)).toEqual({ githubNote: 'gh not installed' });
  });

  it('a failed read keeps the last good lists (the store passes them back), a good one replaces them', async () => {
    fakeGh(`case "$1" in repo) echo '{"nameWithOwner":"acme/shop"}';; pr) cat "${base}/pr.json";; run) cat "${base}/run.json";; esac`);
    process.env.PATH = `${join(base, 'bin')}:${path ?? ''}`;
    const good = await loadGithub(base);
    process.env.PATH = join(base, 'empty');
    const offline = await loadGithub(base, good);
    expect(offline).toEqual({ github: 'acme/shop', githubNote: 'gh not installed; showing the last answer', prs: good.prs, ciRuns: good.ciRuns });
    expect(offline.prs).toHaveLength(5);
    // Nothing to keep: the note as it is, and empty lists, also when it keeps failing.
    const failed = await loadGithub(base);
    expect(failed).toEqual({ githubNote: 'gh not installed', prs: [], ciRuns: [] });
    expect(await loadGithub(base, failed)).toEqual(failed);
    process.env.PATH = `${join(base, 'bin')}:${path ?? ''}`;
    fakeGh(`case "$1" in repo) echo '{"nameWithOwner":"acme/shop"}';; pr) echo '[]';; run) echo '[]';; esac`);
    expect(await loadGithub(base, good)).toEqual({ github: 'acme/shop', prs: [], ciRuns: [] });
  });
});
