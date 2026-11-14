// Where the project stands: the version, the last tag and what is unreleased. What is planned is the Roadmap board.
import type { JSX } from 'preact';
import type { ChangelogEntry } from '../../src/model';
import { useCockpit } from '../context';
import { plural } from '../format';
import { Icon } from '../icons';
import { Ago, Empty, Section } from '../ui';

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
      </div>
    </Section>
  );
}
