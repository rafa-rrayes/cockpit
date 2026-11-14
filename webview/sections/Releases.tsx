// Where the project stands: the version, the last tag, what is unreleased, and the roadmap ahead.
import type { JSX } from 'preact';
import type { ChangelogEntry, ReleasePlan } from '../../src/model';
import { useCockpit } from '../context';
import { plural } from '../format';
import { Icon } from '../icons';
import { Ago, Chip, Empty, Section } from '../ui';

function statusTone(status?: string): 'ok' | 'info' | 'muted' {
  const s = status?.toLowerCase() ?? '';
  if (s.includes('ship') || s.includes('done') || s.includes('released')) return 'ok';
  if (s.includes('progress') || s.includes('active')) return 'info';
  return 'muted';
}

function Plan({ plan }: { plan: ReleasePlan }): JSX.Element {
  const done = plan.items.filter((i) => i.done).length;
  const total = plan.items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <li class="plan">
      <div class="plan-head">
        <span class="plan-version mono">{plan.version}</span>
        {plan.title && <span class="plan-title">{plan.title}</span>}
        {plan.status && <Chip tone={statusTone(plan.status)}>{plan.status}</Chip>}
      </div>
      {plan.target && <p class="plan-target">{plan.target}</p>}
      {total > 0 && (
        <div class="progress-row">
          <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${plan.version} progress`}>
            <div class="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span class="progress-text">
            {done} of {total}
          </span>
        </div>
      )}
      {total > 0 && (
        <ul class="plan-items">
          {plan.items.map((item, i) => (
            <li key={i} class={item.done ? 'plan-item plan-done' : 'plan-item'}>
              <span class="plan-check">{item.done ? <Icon name="check" label="Done" /> : <span class="plan-open" role="img" aria-label="To do" />}</span>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ChangeList({ entry }: { entry: ChangelogEntry }): JSX.Element {
  return entry.lines.length > 0 ? (
    <ul class="changes">
      {entry.lines.map((line, i) => (
        <li key={i}>{line}</li>
      ))}
    </ul>
  ) : (
    <Empty>Nothing written down yet.</Empty>
  );
}

export function Releases(): JSX.Element {
  const { state } = useCockpit();
  const r = state.releases;
  const unreleased = r.changelog.find((e) => e.version.toLowerCase() === 'unreleased');
  const earlier = r.changelog.filter((e) => e !== unreleased);

  return (
    <Section id="releases" title="Releases">
      <div class="release-facts">
        {r.currentVersion && (
          <div class="release-fact">
            <span class="release-label">Version</span>
            <span class="release-value mono">{r.currentVersion}</span>
            {r.versionSource && <span class="muted mono">{r.versionSource}</span>}
          </div>
        )}
        {r.latestTag && (
          <div class="release-fact">
            <span class="release-label">Latest tag</span>
            <span class="release-value mono">
              <Icon name="tag" /> {r.latestTag}
            </span>
            <span class="muted">
              {r.latestTagAt !== undefined && <Ago at={r.latestTagAt} long />}
              {r.commitsSinceTag !== undefined && (
                <>
                  {r.latestTagAt !== undefined && ' · '}
                  {plural(r.commitsSinceTag, 'commit')} since
                </>
              )}
            </span>
          </div>
        )}
      </div>

      <div class="release-grid">
        <div class="release-col">
          <h3 class="sub-head">Unreleased</h3>
          {unreleased ? <ChangeList entry={unreleased} /> : <Empty>No “Unreleased” section in the changelog.</Empty>}
          {earlier.length > 0 && (
            <details class="earlier">
              <summary>Earlier releases</summary>
              {earlier.map((e) => (
                <div key={e.version} class="earlier-entry">
                  <h4>
                    <span class="mono">{e.version}</span>
                    {e.date && <span class="muted"> · {e.date}</span>}
                  </h4>
                  <ChangeList entry={e} />
                </div>
              ))}
            </details>
          )}
        </div>
        <div class="release-col">
          <h3 class="sub-head">Roadmap</h3>
          {r.roadmap.length > 0 ? (
            <ul class="plans">
              {r.roadmap.map((p) => (
                <Plan key={p.version} plan={p} />
              ))}
            </ul>
          ) : (
            <Empty>No planned release in ROADMAP.md.</Empty>
          )}
        </div>
      </div>
    </Section>
  );
}
