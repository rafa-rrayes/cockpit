// What happened lately, newest first, grouped by day.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { ActivityEvent, ActivityKind } from '../../src/model';
import { useCockpit } from '../context';
import { clockTime, dayKey, dayLabel, fullDate } from '../format';
import { Icon, type IconName } from '../icons';
import { Empty, Section } from '../ui';

const kinds: Record<ActivityKind, { icon: IconName; word: string }> = {
  commit: { icon: 'commit', word: 'Commit' },
  session_started: { icon: 'play', word: 'Session started' },
  session_ended: { icon: 'stop', word: 'Session ended' },
  ci: { icon: 'ci', word: 'CI' },
  pr: { icon: 'pr', word: 'Pull request' },
};

// The timeline sits at the bottom of the page: a first screenful, the rest on request.
const FIRST = 20;

function Row({ event: e }: { event: ActivityEvent }): JSX.Element {
  const { state, post, openSession } = useCockpit();
  const kind = kinds[e.kind];
  const session = e.sessionId ? state.sessions[e.sessionId] : undefined;
  const content = (
    <>
      <time class="act-time" dateTime={new Date(e.at).toISOString()} title={fullDate(e.at)}>
        {clockTime(e.at)}
      </time>
      <span class={`act-icon act-${e.kind}`}>
        <Icon name={kind.icon} label={kind.word} />
      </span>
      <span class="act-text">
        <span class="act-title">{e.title}</span>
        {e.detail && <span class="act-detail">{e.detail}</span>}
      </span>
      {e.branch && <span class="act-branch mono">{e.branch}</span>}
    </>
  );
  const url = e.url;
  const open = session ? () => openSession(session.sessionId) : url ? () => post({ type: 'openUrl', url }) : undefined;
  return <li>{open ? <button type="button" class="act-row" onClick={open}>{content}</button> : <div class="act-row">{content}</div>}</li>;
}

export function Activity(): JSX.Element {
  const { state } = useCockpit();
  const [all, setAll] = useState(false);
  const events = all ? state.activity : state.activity.slice(0, FIRST);
  const now = Date.now();

  const days: { key: number; events: ActivityEvent[] }[] = [];
  for (const e of events) {
    const key = dayKey(e.at);
    const last = days[days.length - 1];
    if (last && last.key === key) last.events.push(e);
    else days.push({ key, events: [e] });
  }

  return (
    <Section id="activity" title="Activity">
      {days.length === 0 && <Empty>Nothing has happened yet: commits, sessions, CI runs and pull requests show up here.</Empty>}
      {days.map((d) => (
        <div key={d.key} class="day">
          <h3 class="day-head">{dayLabel(d.key, now)}</h3>
          <ul class="timeline">
            {d.events.map((e, i) => (
              <Row key={`${e.at}:${i}`} event={e} />
            ))}
          </ul>
        </div>
      ))}
      {state.activity.length > FIRST && (
        <button type="button" class="link more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${state.activity.length}`}
        </button>
      )}
    </Section>
  );
}
