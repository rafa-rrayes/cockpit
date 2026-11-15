// Small pieces shared by the sections: status words, status dots, ticking times, section frames.
import type { ComponentChildren, JSX, RefObject } from 'preact';
import { useEffect, useId } from 'preact/hooks';
import { shipProblem } from '../src/catchup';
import type { CheckSummary, CiJob, CiRun, ClaudeSession, SessionStatus, WorkItem } from '../src/model';
import { useCockpit } from './context';
import { finishAction, fullDate, since, sinceLong, useNow } from './format';
import { Icon, type IconName } from './icons';

export const statusWord: Record<SessionStatus, string> = {
  busy: 'Working',
  waiting: 'Waiting',
  idle: 'Idle',
  ended: 'Ended',
  unknown: 'Unknown',
};

/** The status as a person reads it: "Waiting for a permission prompt" rather than "waiting". */
export function statusText(s: ClaudeSession): string {
  if (s.status === 'waiting') return s.waitingFor ? `Waiting: ${s.waitingFor}` : 'Waiting for you';
  return statusWord[s.status];
}

/** A status dot. Colour is never the signal alone: the dot carries the status as its accessible name, or is
 *  `decorative` when the status is written next to it. */
export function StatusDot({ status, decorative = false }: { status: SessionStatus; decorative?: boolean }): JSX.Element {
  if (decorative) return <span class={`dot dot-${status}`} aria-hidden="true" />;
  return <span class={`dot dot-${status}`} role="img" aria-label={statusWord[status]} title={statusWord[status]} />;
}

/** "12m", ticking on its own; the full date is in the tooltip. */
export function Ago({ at, long = false }: { at?: number; long?: boolean }): JSX.Element | null {
  const now = useNow();
  if (at === undefined) return null;
  return (
    <time class="ago" dateTime={new Date(at).toISOString()} title={fullDate(at)}>
      {long ? sinceLong(at, now) : since(at, now)}
    </time>
  );
}

type Tone = 'ok' | 'fail' | 'pending' | 'muted' | 'info';

export function Chip({ tone = 'muted', icon, children, title }: { tone?: Tone; icon?: IconName; children: ComponentChildren; title?: string }): JSX.Element {
  return (
    <span class={`chip chip-${tone}`} title={title}>
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}

const checkInfo: Record<CheckSummary['state'], { tone: Tone; word: string; icon: IconName }> = {
  success: { tone: 'ok', word: 'Checks passed', icon: 'check' },
  failure: { tone: 'fail', word: 'Checks failed', icon: 'x' },
  pending: { tone: 'pending', word: 'Checks running', icon: 'clock' },
  none: { tone: 'muted', word: 'No checks', icon: 'clock' },
};

export const checkStatus = (state: CheckSummary['state']): { tone: Tone; word: string; icon: IconName } => checkInfo[state];

const ciInfo: Record<CiRun['status'], { tone: Tone; word: string; icon: IconName }> = {
  success: { tone: 'ok', word: 'Passed', icon: 'check' },
  failure: { tone: 'fail', word: 'Failed', icon: 'x' },
  in_progress: { tone: 'pending', word: 'Running', icon: 'clock' },
  queued: { tone: 'muted', word: 'Queued', icon: 'clock' },
  cancelled: { tone: 'muted', word: 'Cancelled', icon: 'stop' },
  other: { tone: 'muted', word: 'Other', icon: 'ci' },
};

export const jobStatus = (status: CiJob['status']): { tone: Tone; word: string; icon: IconName } =>
  status === 'skipped' ? { tone: 'muted', word: 'Skipped', icon: 'stop' } : ciInfo[status];

export const ciStatus = (status: CiRun['status']): { tone: Tone; word: string; icon: IconName } => ciInfo[status];

/** A coloured mark with its word next to it, for CI and check states. */
export function StateMark({ tone, word, icon, compact = false }: { tone: Tone; word: string; icon: IconName; compact?: boolean }): JSX.Element {
  return (
    <span class={`mark mark-${tone}`} title={word}>
      <Icon name={icon} label={compact ? word : undefined} />
      {!compact && <span>{word}</span>}
    </span>
  );
}

interface SectionProps {
  id: string;
  title: string;
  /** Short facts next to the title: "6 live", "main". */
  meta?: ComponentChildren;
  actions?: ComponentChildren;
  children: ComponentChildren;
  tone?: 'attention';
}

export function Section({ id, title, meta, actions, children, tone }: SectionProps): JSX.Element {
  return (
    <section class={tone ? `section section-${tone}` : 'section'} id={id} aria-labelledby={`${id}-title`}>
      <header class="section-head">
        <h2 id={`${id}-title`}>{title}</h2>
        {meta && <span class="section-meta">{meta}</span>}
        {actions && <span class="section-actions">{actions}</span>}
      </header>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ComponentChildren }): JSX.Element {
  return <p class="empty">{children}</p>;
}

/** Closes a popup on a mousedown outside `ref` and on Escape. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: (byKey: boolean) => void): void {
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent): void => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) close(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close(true);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key, true);
    };
  }, [open]);
}

interface FinishProps {
  item: WorkItem;
  primary?: boolean;
  /** Only when it can run: a card shows the button when it has something to do, and no reasons. */
  readyOnly?: boolean;
}

/** The button that finishes a branch ("Merge into main…" or "Ship…"). A branch with commits to finish that cannot
 *  be finished yet keeps the button, disabled, with the reason as its tooltip and as a line under it. Nothing for
 *  the default branch, a branch with nothing ahead, or one whose pull request is already the next step. */
export function FinishButton({ item, primary = false, readyOnly = false }: FinishProps): JSX.Element | null {
  const { state, post } = useCockpit();
  const why = useId();
  if (item.isDefault || item.ahead === 0 || (item.pr && item.pr.state !== 'closed')) return null;
  const problem = shipProblem(item, state);
  if (problem && readyOnly) return null;
  const face = finishAction(state.work, item.branch);
  const cls = `btn btn-small${primary ? ' btn-primary' : ''} finish`;
  if (!problem) {
    return (
      <button type="button" class={cls} title={face.title} onClick={() => post({ type: 'ship', branch: item.branch })}>
        <Icon name={face.icon} /> {face.label}
      </button>
    );
  }
  // aria-disabled rather than disabled: the button keeps its tooltip and stays reachable by keyboard.
  return (
    <span class="finish-blocked">
      <button type="button" class={cls} aria-disabled="true" aria-describedby={why} title={problem}>
        <Icon name={face.icon} /> {face.label}
      </button>
      <span class="finish-why muted" id={why}>
        {problem}
      </span>
    </span>
  );
}
