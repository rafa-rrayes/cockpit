// An invented State for the browser preview (dev.html): three projects, sessions in every status, a busy board.
// The shapes match what the host sends; every name, path, prompt and id is made up.
import { parseRoadmap } from '../src/data/roadmap';
import { defaultSettings } from '../src/settings';
import type { ActivityEvent, ActivityKind, ClaudeSession, State, Subagent, WorkItem } from '../src/model';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const HOME = '/Users/dev/src';
const HARBOR = `${HOME}/harbor`;
const QUILL = `${HOME}/quill`;
const ORBIT = `${HOME}/orbit-cli`;
const GH = 'https://github.com/example-org/harbor';

const transcript = (project: string, id: string): string =>
  `/Users/dev/.claude/projects/${project.replace(/[/.]/g, '-')}/${id}.jsonl`;

/** The ROADMAP.md of the sample project: the preview's board edits this text. */
export const sampleRoadmap = `# Roadmap

What ships next, release by release.

## 1.4.1 — Hotfix
Status: shipped

- [x] Crash when a product has no photo

## 1.4.2 — Small fixes

- [x] Faster first load on slow connections
- [x] The date picker works in Safari

## 1.5.0 — Checkout
Target: week of 2026-11-23
Status: in progress

- [x] Order summary visible on small phones
- [x] Round prices consistently
- [x] Seller badges on the profile
- [~] Payment step on its own screen <!-- cockpit:feat/checkout-redesign -->
- [~] Welcome link lifetime as an env var <!-- cockpit:worktree-1.5.0-welcome-link-lifetime -->
- [~] Seller payouts export <!-- cockpit:worktree-1.5.0-seller-payouts -->
- [~] Daily push digest <!-- cockpit:feat/push-digest -->

## 1.6.0 — Offline drafts
Target: December

- [~] Keep the last ten drafts offline
- [ ] Sync drafts when the connection returns
- [ ] Cache product pages at the edge
- [ ] Shorter onboarding copy

## Backlog

- [ ] Tablet layout
- [ ] Export orders as a spreadsheet
`;

export function sampleState(now = Date.now()): State {
  const ago = (ms: number): number => now - ms;

  const session = (s: Omit<ClaudeSession, 'recentPrompts' | 'subagents' | 'workflows' | 'transcriptPath'> & Partial<ClaudeSession>): ClaudeSession => ({
    recentPrompts: s.lastPrompt ? [s.lastPrompt] : [],
    subagents: [],
    workflows: [],
    transcriptPath: transcript(s.projectKey, s.sessionId),
    claudeVersion: '2.4.11',
    ...s,
  });

  const agent = (id: string, description: string, agentType: string, finished: boolean, minutesAgo: number, workflowRunId?: string): Subagent => ({
    id,
    description,
    agentType,
    model: agentType === 'Explore' ? 'haiku' : 'opus',
    finished,
    updatedAt: ago(minutesAgo * MIN),
    workflowRunId,
  });

  const sessions: ClaudeSession[] = [
    session({
      sessionId: '6f1c2a90-4be7-4d1a-9c55-0e3a7f21b804',
      live: true,
      pid: 41822,
      status: 'busy',
      title: 'Checkout redesign: payment step',
      name: 'harbor-12',
      cwd: `${HOME}/harbor-wt/checkout-redesign`,
      projectKey: HARBOR,
      gitBranch: 'feat/checkout-redesign',
      lastPrompt:
        'Split the payment step into its own screen and keep the order summary visible on small phones. Reuse the address form from the profile page instead of copying it.',
      recentPrompts: [
        'Split the payment step into its own screen and keep the order summary visible on small phones. Reuse the address form from the profile page instead of copying it.',
        'Run the checkout tests again with the new fixtures and tell me which ones still fail.',
        'Why does the total flicker when the coupon is applied? Find the cause before changing anything.',
      ],
      startedAt: ago(2 * HOUR + 14 * MIN),
      updatedAt: ago(20_000),
      inVsCodeTerminal: true,
      subagents: [
        agent('a3f09c11d2e84b7a1', 'Build the payment step screen', 'general-purpose', false, 1, 'wf_7c21e9a4-0b2'),
        agent('a8d41e07c95f2b3c6', 'Write tests for the order summary', 'general-purpose', false, 2, 'wf_7c21e9a4-0b2'),
        agent('a51b7d3e6f0a9c2d4', 'Map where the address form is used', 'Explore', true, 18, 'wf_7c21e9a4-0b2'),
      ],
      workflows: [
        {
          runId: 'wf_7c21e9a4-0b2',
          name: 'checkout-build',
          summary: 'Payment step, order summary and tests, in parallel agents',
          status: 'running',
          agentCount: 4,
          startedAt: ago(41 * MIN),
          phases: [
            { title: 'Survey the checkout code', state: 'done' },
            { title: 'Build the screens', detail: '2 agents working', state: 'current' },
            { title: 'Review', state: 'pending' },
            { title: 'Fix what the review found', state: 'pending' },
          ],
        },
      ],
    }),
    session({
      sessionId: '0d9e4b27-71a3-4c0e-b6f2-58a1c9e3d6a0',
      live: true,
      pid: 39107,
      status: 'waiting',
      waitingFor: 'permission prompt',
      title: 'Push digest e-mails',
      name: 'harbor-9',
      cwd: `${HOME}/harbor-wt/push-digest`,
      projectKey: HARBOR,
      gitBranch: 'feat/push-digest',
      lastPrompt: 'Batch the daily digest so a seller gets one e-mail instead of five. Run the migration on the test database first.',
      recentPrompts: [
        'Batch the daily digest so a seller gets one e-mail instead of five. Run the migration on the test database first.',
        'Show me the digest template rendered with three orders and one cancelled order.',
      ],
      startedAt: ago(5 * HOUR),
      updatedAt: ago(4 * MIN),
    }),
    session({
      sessionId: 'c4a7f310-9d2b-4e81-a0c6-2b5e8d7f1934',
      live: true,
      pid: 40233,
      status: 'idle',
      title: 'Release 1.5 notes and tag',
      name: 'harbor-11',
      cwd: HARBOR,
      projectKey: HARBOR,
      gitBranch: 'main',
      lastPrompt: 'Draft the 1.5.0 changelog from the merged PRs and check every roadmap item is either done or moved.',
      startedAt: ago(3 * HOUR),
      updatedAt: ago(26 * MIN),
      subagents: [
        agent('a0e6c2b9f4d17a385', 'Collect merged PRs since v1.4.0', 'Explore', true, 52, 'wf_19b4d0e2-7aa'),
        agent('a7c3e91d0b5f68a24', 'Check roadmap items against the code', 'general-purpose', true, 44, 'wf_19b4d0e2-7aa'),
        agent('a2d8f05b7e1c94a63', 'Draft the changelog', 'general-purpose', true, 31, 'wf_19b4d0e2-7aa'),
        agent('a9b1d47e3c0f2a856', 'Look for user-facing strings without translations', 'Explore', true, 29),
      ],
      workflows: [
        {
          runId: 'wf_19b4d0e2-7aa',
          name: 'release-audit',
          summary: 'Changelog draft and roadmap check for 1.5.0',
          status: 'completed',
          agentCount: 3,
          startedAt: ago(58 * MIN),
          durationMs: 27 * MIN + 12_000,
          phases: [
            { title: 'Collect', detail: '31 merged PRs', state: 'done' },
            { title: 'Check the roadmap', detail: '2 items moved to 1.6.0', state: 'done' },
            { title: 'Draft the changelog', state: 'done' },
          ],
        },
      ],
    }),
    session({
      sessionId: '9a2e6d51-03c8-4f7b-8e1d-c6b04a9f2e17',
      live: true,
      pid: 42510,
      status: 'busy',
      title: 'Flaky search test on CI',
      name: 'harbor-13',
      cwd: `${HOME}/harbor-wt/search-flake`,
      projectKey: HARBOR,
      gitBranch: 'fix/search-flake',
      lastPrompt: 'The ranking test fails one run in five on CI and never locally. Find out why; do not just add a retry.',
      startedAt: ago(35 * MIN),
      updatedAt: ago(6_000),
      subagents: [agent('a4f8b2c6d0e39a171', 'Find every test that depends on dict order', 'Explore', false, 0)],
    }),
    session({
      sessionId: '3b7c9e02-5a14-4d6f-91b8-e2c0f7a4d359',
      live: false,
      status: 'ended',
      title: 'Onboarding copy review',
      cwd: `${HOME}/harbor-wt/onboarding-copy`,
      projectKey: HARBOR,
      gitBranch: 'feat/onboarding-copy',
      lastPrompt: 'Shorten the onboarding screens to one sentence each and keep the tone friendly.',
      startedAt: ago(DAY + 3 * HOUR),
      updatedAt: ago(DAY + HOUR),
    }),
    session({
      sessionId: 'e81f0a6c-2d97-4b35-a4e0-7c9b15d2f6a8',
      live: false,
      status: 'ended',
      title: 'Map tiles cache',
      cwd: `${HOME}/harbor-wt/agent-a41f09`,
      projectKey: HARBOR,
      gitBranch: 'agent-a41f09',
      lastPrompt: 'Cache map tiles for a week and drop the cache when the style changes.',
      startedAt: ago(4 * DAY + 2 * HOUR),
      updatedAt: ago(4 * DAY),
    }),
    session({
      sessionId: '5c0d8f3a-b6e1-4a27-9f4c-1e8a2d7b0c63',
      live: true,
      pid: 38114,
      status: 'busy',
      title: 'Markdown table editing',
      name: 'quill-4',
      cwd: QUILL,
      projectKey: QUILL,
      gitBranch: 'main',
      lastPrompt: 'Tab should move to the next cell and add a row at the end of the table, like in a spreadsheet.',
      startedAt: ago(HOUR + 5 * MIN),
      updatedAt: ago(45_000),
      subagents: [agent('a6e2c0d9b8f417a35', 'Survey how the editor handles key bindings', 'Explore', true, 40)],
    }),
    session({
      sessionId: 'a0b9e7d2-4c61-4f38-8d5a-93e1f2c6b047',
      live: true,
      pid: 37920,
      status: 'idle',
      title: 'Spellcheck in code blocks',
      name: 'quill-3',
      cwd: `${HOME}/quill-wt/spell-code`,
      projectKey: QUILL,
      gitBranch: 'feat/spell-code',
      lastPrompt: 'Skip spellcheck inside fenced code blocks but keep it in comments.',
      startedAt: ago(6 * HOUR),
      updatedAt: ago(2 * HOUR + 10 * MIN),
    }),
    session({
      sessionId: '7e4f1b8d-9a03-4c2e-b5d6-0f8c3a1e9d72',
      live: true,
      pid: 36001,
      status: 'unknown',
      title: 'Release script dry-run',
      cwd: ORBIT,
      projectKey: ORBIT,
      gitBranch: 'main',
      lastPrompt: 'Dry-run the release script against a scratch tag and show me every command it would run.',
      startedAt: ago(9 * HOUR),
      updatedAt: ago(8 * HOUR + 30 * MIN),
      claudeVersion: '2.3.9',
    }),
    session({
      sessionId: 'f3a1c7e9-6b20-4d58-a9e3-5c7d1b0f8e42',
      live: false,
      status: 'ended',
      title: 'Welcome link lifetime as an env var',
      cwd: `${HARBOR}/.claude/worktrees/1.5.0-welcome-link-lifetime`,
      projectKey: HARBOR,
      gitBranch: 'worktree-1.5.0-welcome-link-lifetime',
      lastPrompt: 'Work on this card from the roadmap of harbor (ROADMAP.md): Welcome link lifetime as an env var (1.5.0)',
      startedAt: ago(2 * HOUR),
      updatedAt: ago(38 * MIN),
      report: [
        '## What changed',
        '- The welcome link lifetime comes from `WELCOME_LINK_TTL_HOURS` (default 72), read once at startup.',
        '- An expired link shows a page that offers a new link instead of a bare 404.',
        '',
        '## How I verified it',
        '- `npm test`: 214 passed, 6 of them new, for the expiry page.',
        '- Ran the server with the variable at 1 and opened an expired link by hand.',
        '',
        '## Still open',
        '- Create the production API token for the mailer (it needs an admin account)',
        '- Set `WELCOME_LINK_TTL_HOURS` in the production environment',
      ].join('\n'),
    }),
    session({
      sessionId: '1d6b0e4f-8c35-4a92-b7f1-e2a9c5d3f086',
      live: false,
      status: 'ended',
      title: 'Seller payouts export',
      cwd: `${HARBOR}/.claude/worktrees/1.5.0-seller-payouts`,
      projectKey: HARBOR,
      gitBranch: 'worktree-1.5.0-seller-payouts',
      lastPrompt: 'Work on this card from the roadmap of harbor (ROADMAP.md): Seller payouts export (1.5.0)',
      startedAt: ago(3 * HOUR),
      updatedAt: ago(52 * MIN),
      report: 'I committed the payout schedule. The CSV export is half done: the column mapping and its tests are not committed yet, and two tests fail on rounding.\n\n**Left open:** finishing the export.',
    }),
    session({
      sessionId: 'd2c5a9f0-1e7b-4a83-96d4-b0e7f3c18a25',
      live: false,
      status: 'ended',
      title: 'Shell completions for zsh',
      cwd: ORBIT,
      projectKey: ORBIT,
      gitBranch: 'feat/zsh-completions',
      lastPrompt: 'Generate zsh completions from the command definitions instead of keeping a hand-written file.',
      startedAt: ago(2 * DAY + 4 * HOUR),
      updatedAt: ago(2 * DAY + 2 * HOUR),
    }),
  ];

  const byId: Record<string, ClaudeSession> = {};
  for (const s of sessions) byId[s.sessionId] = s;
  const idsOf = (key: string): string[] => sessions.filter((s) => s.projectKey === key).map((s) => s.sessionId);
  const id = (title: string): string => sessions.find((s) => s.title === title)?.sessionId ?? '';

  const item = (w: Partial<WorkItem> & Pick<WorkItem, 'branch' | 'group'>): WorkItem => ({
    isDefault: false,
    isCurrent: false,
    dirtyCount: 0,
    ahead: 0,
    behind: 0,
    pushed: true,
    sessionIds: [],
    ...w,
  });
  const wt = (name: string): string => `${HOME}/harbor-wt/${name}`;
  const agentBranch = (name: string, daysAgo: number, subject: string): WorkItem =>
    item({ branch: name, group: 'merged', worktreePath: wt(name), pushed: false, lastCommitAt: ago(daysAgo * DAY), lastCommitSubject: subject });

  const items: WorkItem[] = [
    item({
      branch: 'main',
      group: 'active',
      isDefault: true,
      isCurrent: true,
      worktreePath: HARBOR,
      dirtyCount: 1,
      lastCommitAt: ago(25 * MIN),
      lastCommitSubject: 'Search ranking uses the new tokenizer',
      sessionIds: [id('Release 1.5 notes and tag')],
    }),
    item({
      branch: 'feat/checkout-redesign',
      group: 'active',
      worktreePath: wt('checkout-redesign'),
      dirtyCount: 4,
      ahead: 6,
      behind: 2,
      lastCommitAt: ago(12 * MIN),
      lastCommitSubject: 'Checkout: order summary stays visible on small screens',
      pr: { number: 214, title: 'Checkout redesign', url: `${GH}/pull/214`, branch: 'feat/checkout-redesign', isDraft: false, state: 'open', reviewDecision: 'review_required', checks: { state: 'pending', url: `${GH}/pull/214/checks` }, updatedAt: ago(12 * MIN) },
      sessionIds: [id('Checkout redesign: payment step')],
    }),
    item({
      branch: 'feat/push-digest',
      group: 'active',
      worktreePath: wt('push-digest'),
      ahead: 3,
      lastCommitAt: ago(HOUR + 5 * MIN),
      lastCommitSubject: 'Digest: one e-mail per seller per day',
      pr: { number: 212, title: 'Daily push digest', url: `${GH}/pull/212`, branch: 'feat/push-digest', isDraft: true, state: 'open', checks: { state: 'failure', url: `${GH}/pull/212/checks` }, updatedAt: ago(HOUR) },
      sessionIds: [id('Push digest e-mails')],
    }),
    item({
      branch: 'fix/search-flake',
      group: 'active',
      worktreePath: wt('search-flake'),
      dirtyCount: 2,
      ahead: 1,
      pushed: false,
      lastCommitAt: ago(20 * MIN),
      lastCommitSubject: 'Search test: sort results before comparing',
      sessionIds: [id('Flaky search test on CI')],
    }),
    item({
      branch: 'feat/onboarding-copy',
      group: 'active',
      worktreePath: wt('onboarding-copy'),
      ahead: 2,
      behind: 9,
      lastCommitAt: ago(DAY + HOUR),
      lastCommitSubject: 'Onboarding: one sentence per screen',
      pr: { number: 208, title: 'Shorter onboarding copy', url: `${GH}/pull/208`, branch: 'feat/onboarding-copy', isDraft: false, state: 'open', reviewDecision: 'changes_requested', checks: { state: 'success', url: `${GH}/pull/208/checks` }, updatedAt: ago(5 * HOUR) },
      sessionIds: [id('Onboarding copy review')],
    }),
    item({
      branch: 'worktree-1.5.0-welcome-link-lifetime',
      group: 'active',
      worktreePath: `${HARBOR}/.claude/worktrees/1.5.0-welcome-link-lifetime`,
      ahead: 3,
      pushed: false,
      lastCommitAt: ago(40 * MIN),
      lastCommitSubject: 'Welcome links: expired page offers a new link',
      sessionIds: [id('Welcome link lifetime as an env var')],
    }),
    item({
      branch: 'worktree-1.5.0-seller-payouts',
      group: 'active',
      worktreePath: `${HARBOR}/.claude/worktrees/1.5.0-seller-payouts`,
      dirtyCount: 10,
      ahead: 1,
      pushed: false,
      lastCommitAt: ago(70 * MIN),
      lastCommitSubject: 'Payouts: weekly schedule per seller',
      sessionIds: [id('Seller payouts export')],
    }),
    item({
      branch: 'feat/seller-badges',
      group: 'active',
      ahead: 5,
      behind: 1,
      lastCommitAt: ago(3 * HOUR),
      lastCommitSubject: 'Badges: show the level on the profile header',
      pr: { number: 210, title: 'Seller badges', url: `${GH}/pull/210`, branch: 'feat/seller-badges', isDraft: false, state: 'open', reviewDecision: 'approved', checks: { state: 'success', url: `${GH}/pull/210/checks` }, updatedAt: ago(2 * HOUR) },
    }),
    { ...agentBranch('agent-a41f09', 4, 'Map tiles: cache for a week'), sessionIds: [id('Map tiles cache')] },
    agentBranch('agent-b03c77', 3, 'Admin: export orders as CSV'),
    agentBranch('agent-c9d2e1', 3, 'Fix the date picker in Safari'),
    item({
      branch: 'fix/price-rounding',
      group: 'merged',
      lastCommitAt: ago(5 * HOUR),
      lastCommitSubject: 'Prices: round half to even',
      pr: { number: 205, title: 'Round prices consistently', url: `${GH}/pull/205`, branch: 'fix/price-rounding', isDraft: false, state: 'merged', reviewDecision: 'approved', checks: { state: 'success' }, updatedAt: ago(4 * HOUR) },
    }),
    item({
      branch: 'chore/deps-november',
      group: 'merged',
      lastCommitAt: ago(2 * DAY),
      lastCommitSubject: 'Update dependencies',
      pr: { number: 206, title: 'November dependency updates', url: `${GH}/pull/206`, branch: 'chore/deps-november', isDraft: false, state: 'merged', checks: { state: 'success' }, updatedAt: ago(2 * DAY) },
    }),
    agentBranch('agent-d58e40', 6, 'Translations for the new settings page'),
    agentBranch('agent-e7712b', 6, 'Seller page: lazy-load the gallery'),
    item({
      branch: 'feat/offline-drafts',
      group: 'stale',
      ahead: 4,
      behind: 61,
      lastCommitAt: ago(23 * DAY),
      lastCommitSubject: 'Drafts: keep the last ten offline',
    }),
    item({
      branch: 'spike/edge-cache',
      group: 'stale',
      worktreePath: wt('edge-cache'),
      dirtyCount: 0,
      ahead: 2,
      behind: 80,
      pushed: false,
      lastCommitAt: ago(40 * DAY),
      lastCommitSubject: 'Spike: cache product pages at the edge',
    }),
  ];

  type Ev = [minutesAgo: number, kind: ActivityKind, title: string, extra?: Partial<ActivityEvent>];
  const events: Ev[] = [
    [1, 'ci', 'Deploy staging queued', { branch: 'main', url: `${GH}/actions/runs/9003` }],
    [3, 'ci', 'CI started', { branch: 'feat/checkout-redesign', url: `${GH}/actions/runs/9002` }],
    [12, 'commit', 'Checkout: order summary stays visible on small screens', { branch: 'feat/checkout-redesign' }],
    [20, 'commit', 'Search test: sort results before comparing', { branch: 'fix/search-flake' }],
    [25, 'ci', 'CI failed on main', { detail: 'test-core: 1 failing test', branch: 'main', url: `${GH}/actions/runs/9001` }],
    [25, 'commit', 'Search ranking uses the new tokenizer', { branch: 'main' }],
    [35, 'session_started', 'Flaky search test on CI', { sessionId: id('Flaky search test on CI'), branch: 'fix/search-flake' }],
    [62, 'pr', '#212 Daily push digest updated', { detail: 'Draft', url: `${GH}/pull/212`, branch: 'feat/push-digest' }],
    [65, 'commit', 'Digest: one e-mail per seller per day', { branch: 'feat/push-digest' }],
    [65, 'session_started', 'Markdown table editing', { sessionId: id('Markdown table editing'), detail: 'quill' }],
    [70, 'ci', 'CI failed', { detail: 'lint: unused import', branch: 'feat/push-digest', url: `${GH}/actions/runs/9004` }],
    [120, 'pr', '#210 Seller badges approved', { url: `${GH}/pull/210`, branch: 'feat/seller-badges' }],
    [125, 'ci', 'CI passed', { branch: 'feat/seller-badges', url: `${GH}/actions/runs/9005` }],
    [134, 'session_started', 'Checkout redesign: payment step', { sessionId: id('Checkout redesign: payment step'), branch: 'feat/checkout-redesign' }],
    [180, 'commit', 'Badges: show the level on the profile header', { branch: 'feat/seller-badges' }],
    [180, 'session_started', 'Release 1.5 notes and tag', { sessionId: id('Release 1.5 notes and tag'), branch: 'main' }],
    [240, 'pr', '#205 Round prices consistently merged', { url: `${GH}/pull/205`, branch: 'fix/price-rounding' }],
    [300, 'pr', '#208 Shorter onboarding copy: changes requested', { url: `${GH}/pull/208`, branch: 'feat/onboarding-copy' }],
    [300, 'session_started', 'Push digest e-mails', { sessionId: id('Push digest e-mails'), branch: 'feat/push-digest' }],
    [360, 'session_started', 'Spellcheck in code blocks', { sessionId: id('Spellcheck in code blocks'), detail: 'quill' }],
    [540, 'session_started', 'Release script dry-run', { sessionId: id('Release script dry-run'), detail: 'orbit-cli' }],
    [24 * 60 + 60, 'session_ended', 'Onboarding copy review', { sessionId: id('Onboarding copy review') }],
    [24 * 60 + 60, 'commit', 'Onboarding: one sentence per screen', { branch: 'feat/onboarding-copy' }],
    [24 * 60 + 120, 'ci', 'CI cancelled', { branch: 'feat/onboarding-copy', url: `${GH}/actions/runs/9008` }],
    [24 * 60 + 180, 'session_started', 'Onboarding copy review', { sessionId: id('Onboarding copy review') }],
    [24 * 60 + 300, 'commit', 'Admin: export orders as CSV', { branch: 'agent-b03c77' }],
    [2 * 24 * 60, 'pr', '#206 November dependency updates merged', { url: `${GH}/pull/206`, branch: 'chore/deps-november' }],
    [2 * 24 * 60 + 120, 'session_ended', 'Shell completions for zsh', { sessionId: id('Shell completions for zsh'), detail: 'orbit-cli' }],
    [3 * 24 * 60, 'ci', 'Release v1.4.0 passed', { url: `${GH}/actions/runs/9007` }],
    [3 * 24 * 60 + 30, 'commit', 'Release 1.4.0', { branch: 'main' }],
  ];
  const activity: ActivityEvent[] = events.map(([m, kind, title, extra]) => ({ kind, title, at: ago(m * MIN), ...extra }));

  return {
    generatedAt: now,
    workspace: { name: 'harbor', path: HARBOR },
    attention: [
      {
        kind: 'session_waiting',
        title: 'Push digest e-mails',
        detail: 'Waiting for a permission prompt: run the migration on the test database',
        sessionId: id('Push digest e-mails'),
        at: ago(4 * MIN),
      },
      { kind: 'ci_failed', title: 'CI failed on main', detail: 'test-core: tests/search/test_ranking.py', url: `${GH}/actions/runs/9001`, at: ago(19 * MIN) },
      { kind: 'session_uncommitted', title: 'Seller payouts export', detail: '10 uncommitted files in worktree-1.5.0-seller-payouts', sessionId: id('Seller payouts export'), at: ago(52 * MIN) },
      { kind: 'pr_changes_requested', title: '#208 Shorter onboarding copy', detail: 'Changes requested on the second screen', url: `${GH}/pull/208`, at: ago(5 * HOUR) },
    ],
    // Three hours ago: #205 had not merged yet and #212's checks were still running.
    caughtUp: { at: ago(3 * HOUR), prs: { 205: 'success', 206: 'merged', 208: 'success', 210: 'success', 212: 'pending', 214: 'pending' } },
    sessions: byId,
    projects: [
      { key: HARBOR, name: 'harbor', isWorkspace: true, sessionIds: idsOf(HARBOR) },
      { key: QUILL, name: 'quill', isWorkspace: false, sessionIds: idsOf(QUILL) },
      { key: ORBIT, name: 'orbit-cli', isWorkspace: false, sessionIds: idsOf(ORBIT) },
    ],
    work: {
      available: true,
      repoRoot: HARBOR,
      defaultBranch: 'main',
      github: 'example-org/harbor',
      hasOrigin: true,
      delivery: 'pr',
      items,
      ciRuns: [
        { id: 9003, title: 'Search ranking uses the new tokenizer', workflow: 'Deploy staging', branch: 'main', status: 'queued', url: `${GH}/actions/runs/9003`, startedAt: ago(MIN) },
        { id: 9002, title: 'Checkout: order summary stays visible on small screens', workflow: 'CI', branch: 'feat/checkout-redesign', status: 'in_progress', url: `${GH}/actions/runs/9002`, startedAt: ago(3 * MIN), jobs: [{ name: 'changes', status: 'success', durationMs: 9_000 }, { name: 'core', status: 'in_progress', startedAt: ago(2 * MIN) }, { name: 'app', status: 'skipped' }, { name: 'edge', status: 'success', durationMs: 41_000 }, { name: 'infra', status: 'queued' }] },
        { id: 9001, title: 'Search ranking uses the new tokenizer', workflow: 'CI', branch: 'main', status: 'failure', url: `${GH}/actions/runs/9001`, startedAt: ago(25 * MIN), durationMs: 6 * MIN + 12_000 },
        { id: 9004, title: 'Digest: one e-mail per seller per day', workflow: 'CI', branch: 'feat/push-digest', status: 'failure', url: `${GH}/actions/runs/9004`, startedAt: ago(70 * MIN), durationMs: 2 * MIN + 41_000 },
        { id: 9005, title: 'Badges: show the level on the profile header', workflow: 'CI', branch: 'feat/seller-badges', status: 'success', url: `${GH}/actions/runs/9005`, startedAt: ago(125 * MIN), durationMs: 5 * MIN + 40_000 },
        { id: 9006, title: 'Prices: round half to even', workflow: 'CI', branch: 'fix/price-rounding', status: 'success', url: `${GH}/actions/runs/9006`, startedAt: ago(5 * HOUR), durationMs: 5 * MIN + 2_000 },
        { id: 9008, title: 'Onboarding: one sentence per screen', workflow: 'CI', branch: 'feat/onboarding-copy', status: 'cancelled', url: `${GH}/actions/runs/9008`, startedAt: ago(DAY + 2 * HOUR), durationMs: 48_000 },
        { id: 9007, title: 'Release 1.4.0', workflow: 'Release', branch: 'v1.4.0', status: 'success', url: `${GH}/actions/runs/9007`, startedAt: ago(3 * DAY), durationMs: 11 * MIN + 30_000 },
      ],
    },
    releases: {
      available: true,
      currentVersion: '1.4.0',
      versionSource: 'app/app.json',
      latestTag: 'v1.4.0',
      latestTagAt: ago(3 * DAY),
      tags: ['v1.4.0', 'v1.3.0', 'v1.2.0'],
      commitsSinceTag: 23,
      roadmapPath: `${HARBOR}/ROADMAP.md`,
      roadmapName: 'ROADMAP.md',
      roadmapExists: true,
      roadmap: parseRoadmap(sampleRoadmap),
      changelog: [
        {
          version: 'Unreleased',
          lines: [
            'Prices round half to even everywhere, so totals match the receipt.',
            'The order summary stays visible on small phones during checkout.',
            'Sellers see their badge level on the profile header.',
            'Search ranks exact matches first.',
            'Admin can export orders as CSV.',
          ],
        },
        {
          version: '1.4.0',
          date: '2026-11-10',
          lines: ['Map tiles are cached for a week.', 'The date picker works in Safari.', 'Settings page in English and Spanish.', 'The seller gallery loads lazily.'],
        },
        { version: '1.3.2', date: '2026-10-29', lines: ['Fix a crash when a product has no photo.', 'Faster first load on slow connections.'] },
      ],
    },
    activity,
    settings: defaultSettings,
  };
}
