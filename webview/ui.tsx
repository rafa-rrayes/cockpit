// Small pieces shared by the sections: status words, status dots, ticking times, section frames.
import type { ComponentChildren, JSX } from 'preact';
import type { CheckSummary, CiRun, ClaudeSession, SessionStatus } from '../src/model';
import { fullDate, since, sinceLong, useNow } from './format';
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
