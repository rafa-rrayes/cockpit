// Branches and worktrees as a board (In progress / Merged / Stale) with their PRs and Claudes, and CI below.
import type { JSX } from 'preact';
import type { CiRun, ClaudeSession, PullRequest, WorkGroup, WorkItem } from '../../src/model';
import { useCockpit } from '../context';
import { baseName, deliveryText, duration, plural } from '../format';
import { Icon } from '../icons';
import { Ago, Chip, Empty, FinishButton, Section, StateMark, StatusDot, checkStatus, ciStatus } from '../ui';

// Long columns (a pile of merged agent worktrees) show this many until opened.
const FOLDED_LIMIT = 6;
// The main checkout gathers every Claude that ever ran there: live ones always show, ended ones up to this many.
const ENDED_PILLS = 2;

const columns: { group: WorkGroup; title: string; hint: string; empty: string }[] = [
  { group: 'active', title: 'In progress', hint: 'commits or changes not on the default branch', empty: 'Nothing in progress.' },
  { group: 'merged', title: 'Merged', hint: 'nothing left to merge: safe to clean', empty: 'No merged branch to clean.' },
  { group: 'stale', title: 'Stale', hint: 'unmerged, no commit for 14 days', empty: 'No stale branch.' },
];

const review = {
  approved: { tone: 'ok', word: 'Approved' },
  changes_requested: { tone: 'fail', word: 'Changes requested' },
  review_required: { tone: 'muted', word: 'Review required' },
} as const;

// Agent worktrees are named after their branch: say "worktree" rather than repeat the name.
const worktreeLabel = (path: string, branch: string): string => {
  const name = baseName(path);
  return name === baseName(branch) ? 'worktree' : name;
};

function PrRow({ pr }: { pr: PullRequest }): JSX.Element {
  const { post } = useCockpit();
  const checks = checkStatus(pr.checks.state);
  const checksUrl = pr.checks.url;
  return (
    <div class="pr">
      <button type="button" class="pr-link" title={`Open #${pr.number} on GitHub`} onClick={() => post({ type: 'openUrl', url: pr.url })}>
        <Icon name={pr.state === 'merged' ? 'merge' : 'pr'} />
        <span class="pr-number">#{pr.number}</span>
        <span class="pr-title">{pr.title}</span>
      </button>
      <span class="pr-marks">
        {pr.isDraft && <Chip>Draft</Chip>}
        {pr.state !== 'open' && <Chip>{pr.state}</Chip>}
        {pr.reviewDecision && <Chip tone={review[pr.reviewDecision].tone}>{review[pr.reviewDecision].word}</Chip>}
        {pr.checks.state !== 'none' &&
          (checksUrl ? (
            <button type="button" class="mark-button" onClick={() => post({ type: 'openUrl', url: checksUrl })}>
              <StateMark {...checks} compact />
            </button>
          ) : (
            <StateMark {...checks} compact />
          ))}
      </span>
    </div>
  );
}

function ItemCard({ item }: { item: WorkItem }): JSX.Element {
  const { state, post, openSession } = useCockpit();
  const all = item.sessionIds.map((id) => state.sessions[id]).filter((s): s is ClaudeSession => s !== undefined);
  const ended = all.filter((s) => !s.live);
  const sessions = [...all.filter((s) => s.live), ...ended.slice(0, ENDED_PILLS)];
  const hiddenEnded = ended.length - Math.min(ended.length, ENDED_PILLS);
  const worktree = item.worktreePath;

  return (
    <li class={`work-item work-${item.group}`}>
      <div class="work-head">
        <Icon name="branch" />
        <span class="work-branch mono" title={item.branch}>
          {item.branch}
        </span>
        {item.isDefault && <span class="tag">default</span>}
        {item.isCurrent && <span class="tag">checked out</span>}
      </div>
      <div class="work-facts">
        {worktree && (
          <button
            type="button"
            class="fact-button"
            title={`Open the worktree ${worktree} in a new window`}
            onClick={() => post({ type: 'openFolder', path: worktree, newWindow: true })}
          >
            <Icon name="folder" />
            {worktreeLabel(worktree, item.branch)}
          </button>
        )}
        {item.dirtyCount > 0 && (
          <span class="fact-warn" title={`${plural(item.dirtyCount, 'uncommitted file')}`}>
            {item.dirtyCount} changed
          </span>
        )}
        {(item.ahead > 0 || item.behind > 0) && (
          <span class="ahead-behind" title={`${item.ahead} ahead, ${item.behind} behind the default branch`}>
            {item.ahead > 0 && <span>↑{item.ahead}</span>}
            {item.behind > 0 && <span>↓{item.behind}</span>}
            <span class="sr-only">
              {item.ahead} ahead, {item.behind} behind
            </span>
          </span>
        )}
        {!item.pushed && !item.isDefault && <span class="muted">local only</span>}
      </div>
      {item.lastCommitSubject && (
        <p class="work-commit">
          <span class="work-commit-subject">{item.lastCommitSubject}</span>
          <Ago at={item.lastCommitAt} />
        </p>
      )}
      {item.pr && <PrRow pr={item.pr} />}
      <div class="work-ship">
        <FinishButton item={item} />
      </div>
      {sessions.length > 0 && (
        <ul class="work-sessions" aria-label="Agents on this branch">
          {sessions.map((s) => (
            <li key={s.sessionId}>
              <button type="button" class="session-pill" onClick={() => openSession(s.sessionId)}>
                <StatusDot status={s.status} />
                <span class="session-pill-title">{s.title}</span>
              </button>
            </li>
          ))}
          {hiddenEnded > 0 && <li class="session-more muted">+{hiddenEnded} ended</li>}
        </ul>
      )}
    </li>
  );
}

function Column({ group, title, hint, empty, items }: (typeof columns)[number] & { items: WorkItem[] }): JSX.Element {
  const { ui, update, post } = useCockpit();
  const expanded = ui.expanded[group] === true;
  const shown = expanded ? items : items.slice(0, FOLDED_LIMIT);
  const cleanable = group === 'merged' && items.some((i) => !i.isDefault);

  return (
    <div class="column" role="group" aria-labelledby={`col-${group}`}>
      <div class="column-head">
        <h3 id={`col-${group}`}>
          {title} <span class="count">{items.length}</span>
        </h3>
        {cleanable && (
          <button type="button" class="btn btn-small" onClick={() => post({ type: 'cleanMerged' })} title="Lists what it would delete and asks first">
            Clean merged…
          </button>
        )}
      </div>
      <p class="column-hint">{hint}</p>
      {items.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <ul class="work-items">
          {shown.map((item) => (
            <ItemCard key={item.branch} item={item} />
          ))}
        </ul>
      )}
      {items.length > FOLDED_LIMIT && (
        <button
          type="button"
          class="link more"
          aria-expanded={expanded}
          onClick={() => update((prev) => ({ expanded: { ...prev.expanded, [group]: !expanded } }))}
        >
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

function CiRow({ run }: { run: CiRun }): JSX.Element {
  const { post } = useCockpit();
  const st = ciStatus(run.status);
  return (
    <li>
      <button type="button" class={`ci-row ci-${run.status}`} onClick={() => post({ type: 'openUrl', url: run.url })}>
        <StateMark tone={st.tone} word={st.word} icon={st.icon} />
        <span class="ci-workflow">{run.workflow}</span>
        <span class="ci-title">{run.title}</span>
        <span class="ci-branch mono">{run.branch}</span>
        <span class="ci-time">
          <Ago at={run.startedAt} />
          {run.durationMs !== undefined && <span class="muted"> · {duration(run.durationMs)}</span>}
        </span>
      </button>
    </li>
  );
}

export function Work(): JSX.Element {
  const { state } = useCockpit();
  const { work } = state;
  const byGroup = (g: WorkGroup): WorkItem[] => work.items.filter((i) => i.group === g);
  const delivery = deliveryText(work);

  return (
    <Section
      id="work"
      title="Work"
      meta={
        <>
          {work.defaultBranch && (
            <span class="mono" title="Default branch">
              {work.defaultBranch}
            </span>
          )}
          <Chip title={delivery.title}>{delivery.text}</Chip>
          {/* Shown beside the name too: lists kept from an earlier answer, or one gh call that failed. In direct
              delivery GitHub is not needed, and "no remote" would read as an error. */}
          {work.githubNote && work.delivery === 'pr' && <span class="muted">GitHub: {work.githubNote}</span>}
        </>
      }
    >
      <div class="board">
        {columns.map((c) => (
          <Column key={c.group} {...c} items={byGroup(c.group)} />
        ))}
      </div>
      {work.ciRuns.length > 0 && (
        <div class="ci">
          <h3 class="sub-head">
            CI runs <span class="count">{work.ciRuns.length}</span>
          </h3>
          <ul class="ci-list">
            {work.ciRuns.map((r) => (
              <CiRow key={r.id} run={r} />
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}
