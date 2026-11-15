// Catch up: a drawer with what changed since the person last looked, each entry with its one next action. Closing it
// tells the host that all of it was seen, so the next Catch up starts from here.
import type { JSX } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { type CatchUpEntry, catchUp, laneOf, type NextAction } from '../../src/catchup';
import type { RoadmapItem } from '../../src/model';
import { useCockpit } from '../context';
import { plural } from '../format';
import { Icon } from '../icons';
import { Report } from '../Report';
import { Ago, Chip, Empty, FinishButton, StatusDot, statusText } from '../ui';

function Cards({ cards }: { cards: RoadmapItem[] }): JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <ul class="cu-cards" aria-label="Roadmap cards">
      {cards.map((c) => (
        <li key={c.id}>
          <Chip tone={c.status === 'done' ? 'ok' : c.status === 'doing' ? 'info' : 'muted'}>{c.text}</Chip>
        </li>
      ))}
    </ul>
  );
}

function Entry({ entry, onClose }: { entry: CatchUpEntry; onClose(): void }): JSX.Element {
  const { state, post, openSession } = useCockpit();
  const base = state.work.defaultBranch ?? 'main';

  const act = (action: NextAction): void => {
    if (entry.kind === 'pr') {
      if (action === 'pull') post({ type: 'pullDefault' });
      else post({ type: 'openUrl', url: entry.pr.url });
      return;
    }
    const { session, item } = entry;
    if (action === 'ship' && item) post({ type: 'ship', branch: item.branch });
    else if (action === 'resume') post({ type: 'resumeSession', sessionId: session.sessionId });
    else if (action === 'focus') post({ type: 'focusSession', sessionId: session.sessionId });
    else if (action === 'openPr' && item?.pr) post({ type: 'openUrl', url: item.pr.url });
    else {
      onClose();
      openSession(session.sessionId);
    }
  };

  if (entry.kind === 'pr') {
    const { pr, change } = entry;
    const word = { passed: 'Checks passed', failed: 'Checks failed', merged: 'Merged' }[change];
    const tone = change === 'failed' ? 'fail' : 'ok';
    return (
      <li class={`cu-entry cu-${change}`}>
        <div class="cu-head">
          <Chip tone={tone} icon={change === 'merged' ? 'merge' : change === 'passed' ? 'check' : 'x'}>
            {word}
          </Chip>
          <span class="cu-title">
            #{pr.number} {pr.title}
          </span>
          <Ago at={entry.at} />
        </div>
        <p class="cu-facts">
          <span class="mono">{pr.branch}</span>
        </p>
        <Cards cards={entry.cards} />
        <div class="cu-actions">
          <button type="button" class="btn btn-primary btn-small" onClick={() => act(entry.action)}>
            {entry.action === 'pull' ? (
              <>
                <Icon name="refresh" /> Pull {base}
              </>
            ) : (
              <>
                <Icon name="pr" /> Open #{pr.number}
              </>
            )}
          </button>
          {entry.action === 'pull' && (
            <button type="button" class="btn btn-small" onClick={() => post({ type: 'openUrl', url: pr.url })}>
              Open #{pr.number}
            </button>
          )}
        </div>
      </li>
    );
  }

  const { session: s, item } = entry;
  const labels: Record<Exclude<NextAction, 'ship'>, JSX.Element> = {
    resume: (
      <>
        <Icon name="play" /> Resume
      </>
    ),
    focus: (
      <>
        <Icon name="terminal" /> Focus terminal
      </>
    ),
    openPr: (
      <>
        <Icon name="pr" /> Open #{item?.pr?.number}
      </>
    ),
    pull: <>Pull {base}</>,
    open: <>Details</>,
  };
  const isBranch = item !== undefined && !item.isDefault;
  return (
    <li class={`cu-entry cu-session${item && item.dirtyCount > 0 && isBranch ? ' cu-dirty' : ''}`}>
      <div class="cu-head">
        <StatusDot status={s.status} decorative />
        <span class="cu-status">{statusText(s)}</span>
        <span class="cu-title">{s.title}</span>
        <Ago at={entry.at} />
      </div>
      {item && (
        <p class="cu-facts">
          <span class="mono" title={item.branch}>
            <Icon name="branch" /> {item.branch}
          </span>
          {isBranch && item.ahead > 0 && (
            <span title={item.lastCommitSubject}>
              {plural(item.ahead, 'commit')} ahead of {base}
              {item.lastCommitSubject && <span class="muted"> · last: {item.lastCommitSubject}</span>}
            </span>
          )}
          {isBranch && item.dirtyCount > 0 && <span class="fact-warn">{plural(item.dirtyCount, 'uncommitted file')}</span>}
          {item.pr && (
            <button type="button" class="link" onClick={() => post({ type: 'openUrl', url: item.pr?.url ?? '' })}>
              #{item.pr.number} {item.pr.state === 'open' ? 'in review' : item.pr.state}
            </button>
          )}
        </p>
      )}
      <Cards cards={entry.cards} />
      {s.report && s.status !== 'waiting' ? <Report text={s.report} lane={laneOf(state, item?.branch)} /> : null}
      <div class="cu-actions">
        {entry.action === 'ship' ? (
          item && <FinishButton item={item} primary />
        ) : (
          <button type="button" class="btn btn-primary btn-small" onClick={() => act(entry.action)}>
            {labels[entry.action]}
          </button>
        )}
        {/* Nothing else to do: a branch that has commits to finish but cannot be finished yet says why. */}
        {entry.action === 'open' && item && <FinishButton item={item} />}
        {entry.action !== 'open' && (
          <button type="button" class="btn btn-small" onClick={() => act('open')}>
            Details
          </button>
        )}
      </div>
    </li>
  );
}

export function CatchUp({ onClose }: { onClose(): void }): JSX.Element {
  const { state } = useCockpit();
  const dialog = useRef<HTMLDivElement>(null);
  const entries = catchUp(state);
  const since = state.caughtUp?.at;

  useEffect(() => dialog.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div class="drawer-layer">
      <div class="drawer-backdrop" onClick={onClose} />
      <div class="drawer cu" role="dialog" aria-modal="true" aria-labelledby="cu-title" tabIndex={-1} ref={dialog}>
        <header class="drawer-head">
          <div class="drawer-status">
            {since !== undefined ? (
              <span>
                Since you last looked, <Ago at={since} long />
              </span>
            ) : (
              <span>The last day</span>
            )}
          </div>
          <h2 id="cu-title">Catch up</h2>
          <button type="button" class="btn btn-icon drawer-close" aria-label="Close" title="Close (Esc): all of this counts as seen" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div class="drawer-body">
          {entries.length === 0 ? (
            <Empty>Nothing new: no Claude finished or is waiting, and no pull request changed since you last looked.</Empty>
          ) : (
            <ul class="cu-list">
              {entries.map((e) => (
                <Entry key={e.kind === 'pr' ? `pr:${e.pr.number}` : e.session.sessionId} entry={e} onClose={onClose} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
