// The strip at the top: things blocked on the person. Hidden when there are none.
import type { JSX } from 'preact';
import type { Attention, AttentionKind } from '../../src/model';
import { useCockpit } from '../context';
import { Icon, type IconName } from '../icons';
import { Ago, Section } from '../ui';

const kinds: Record<AttentionKind, { icon: IconName; word: string; action: string }> = {
  session_waiting: { icon: 'person', word: 'Claude is waiting', action: 'Open' },
  ci_failed: { icon: 'x', word: 'CI failed', action: 'Open run' },
  pr_changes_requested: { icon: 'pr', word: 'Changes requested', action: 'Open PR' },
};

export function NeedsYou(): JSX.Element | null {
  const { state, post, openSession } = useCockpit();
  if (state.attention.length === 0) return null;

  const act = (a: Attention): void => {
    if (a.sessionId && state.sessions[a.sessionId]) openSession(a.sessionId);
    else if (a.url) post({ type: 'openUrl', url: a.url });
  };

  return (
    <Section id="needs" title="Needs you" meta={`${state.attention.length}`} tone="attention">
      <ul class="needs">
        {state.attention.map((a, i) => {
          const kind = kinds[a.kind];
          const actionable = (a.sessionId !== undefined && state.sessions[a.sessionId] !== undefined) || a.url !== undefined;
          const body = (
            <>
              <span class={`needs-icon needs-${a.kind}`}>
                <Icon name={kind.icon} />
              </span>
              <span class="needs-text">
                <span class="needs-kind">{kind.word}</span>
                <span class="needs-title">{a.title}</span>
                {a.detail && <span class="needs-detail">{a.detail}</span>}
              </span>
              <span class="needs-end">
                <Ago at={a.at} />
                {actionable && <span class="needs-action">{kind.action}</span>}
              </span>
            </>
          );
          return (
            <li key={`${a.kind}:${a.sessionId ?? a.url ?? i}`} class={a.kind === 'session_waiting' ? undefined : 'needs-fail'}>
              {actionable ? (
                <button type="button" class="needs-item" onClick={() => act(a)}>
                  {body}
                </button>
              ) : (
                <div class="needs-item">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
