// CI runs going on right now (after Ship, say), shown near the top so they are not buried in Work.
// A row opens to the run's jobs, with a button to open the run on GitHub.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { CiRun } from '../../src/model';
import { useCockpit } from '../context';
import { duration } from '../format';
import { Icon } from '../icons';
import { Ago, StateMark, ciStatus, jobStatus } from '../ui';

function Run({ run }: { run: CiRun }): JSX.Element {
  const { post } = useCockpit();
  const [open, setOpen] = useState(false);
  const st = ciStatus(run.status);
  const jobs = run.jobs ?? [];
  const done = jobs.filter((j) => j.status !== 'in_progress' && j.status !== 'queued').length;
  const panel = `ci-run-${run.id}`;
  return (
    <li>
      <div class="ci-run-bar">
      <button type="button" class={`ci-row ci-run-head ci-${run.status}`} aria-expanded={open} aria-controls={panel} onClick={() => setOpen(!open)}>
        <StateMark tone={st.tone} word={st.word} icon={st.icon} />
        <span class="ci-workflow">{run.workflow}</span>
        <span class="ci-title">{run.title}</span>
        <span class="ci-branch mono">{run.branch}</span>
        <span class="ci-time">
          {jobs.length > 0 && <span class="muted">{done}/{jobs.length} jobs · </span>}
          <Ago at={run.startedAt} />
        </span>
      </button>
      <button type="button" class="btn btn-icon" title="Open on GitHub" aria-label="Open on GitHub" onClick={() => post({ type: 'openUrl', url: run.url })}>
        <Icon name="external" />
      </button>
      </div>
      {open && (
        <div class="ci-detail" id={panel}>
          {jobs.length > 0 ? (
            <ul class="ci-jobs" aria-label="Jobs">
              {jobs.map((j) => {
                const js = jobStatus(j.status);
                return (
                  <li key={j.name}>
                    <StateMark tone={js.tone} word={js.word} icon={js.icon} compact />
                    <span class="ci-job-name">{j.name}</span>
                    <span class="muted ci-job-time">{j.durationMs !== undefined ? duration(j.durationMs) : js.word}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p class="muted ci-detail-empty">{run.status === 'queued' ? 'Waiting for a runner.' : 'No jobs listed yet.'}</p>
          )}
        </div>
      )}
    </li>
  );
}

export function CiRunning(): JSX.Element | null {
  const { state } = useCockpit();
  const runs = state.work.ciRuns.filter((r) => r.status === 'in_progress' || r.status === 'queued');
  if (runs.length === 0) return null;
  return (
    <section class="ci-running" aria-label="CI running">
      <h2 class="ci-running-title">
        CI running <span class="count">{runs.length}</span>
      </h2>
      <ul class="ci-list">
        {runs.map((r) => (
          <Run key={r.id} run={r} />
        ))}
      </ul>
    </section>
  );
}
