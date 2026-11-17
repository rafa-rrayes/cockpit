// The side drawer for one session: what it is doing, its agents and workflows, and the actions on it.
// It is modal: the page behind is inert, Esc or the backdrop closes it, and focus goes back where it came from.
import type { JSX } from 'preact';
import { providerLabel, providerFor } from '../../src/providers';
import { useEffect, useRef } from 'preact/hooks';
import { laneOf } from '../../src/catchup';
import type { ClaudeSession, Subagent, WorkflowPhase, WorkflowRun } from '../../src/model';
import { useCockpit } from '../context';
import { duration, fullDate, plural } from '../format';
import { Icon } from '../icons';
import { Report } from '../Report';
import { Ago, Chip, Empty, StatusDot, statusText } from '../ui';

const workflowTone = { running: 'info', completed: 'ok', failed: 'fail', unknown: 'muted' } as const;

function Phase({ phase }: { phase: WorkflowPhase }): JSX.Element {
  const word = phase.state === 'done' ? 'Done' : phase.state === 'current' ? 'Running' : phase.state === 'pending' ? 'Pending' : undefined;
  return (
    <li class={`phase phase-${phase.state ?? 'none'}`}>
      <span class="phase-mark" aria-hidden="true">
        {phase.state === 'done' && <Icon name="check" />}
      </span>
      <span class="phase-text">
        <span class="phase-title">
          {phase.title}
          {word && <span class="sr-only"> ({word})</span>}
        </span>
        {phase.detail && <span class="phase-detail">{phase.detail}</span>}
      </span>
    </li>
  );
}

function Workflow({ run }: { run: WorkflowRun }): JSX.Element {
  const { post } = useCockpit();
  return (
    <li class="workflow">
      <div class="workflow-head">
        <Icon name="workflow" />
        <span class="workflow-name">{run.name ?? 'Workflow'}</span>
        <Chip tone={workflowTone[run.status]}>{run.status}</Chip>
      </div>
      {run.summary && <p class="workflow-summary">{run.summary}</p>}
      <p class="workflow-facts">
        <button type="button" class="link mono" title="Copy the run ID" onClick={() => post({ type: 'copy', text: run.runId })}>
          {run.runId}
        </button>
        {run.agentCount !== undefined && <span>{plural(run.agentCount, 'agent')}</span>}
        {run.startedAt !== undefined && (
          <span>
            started <Ago at={run.startedAt} long />
          </span>
        )}
        {run.durationMs !== undefined && <span>{duration(run.durationMs)}</span>}
      </p>
      {run.phases.length > 0 && (
        <ol class="phases" aria-label="Phases">
          {run.phases.map((p, i) => (
            <Phase key={i} phase={p} />
          ))}
        </ol>
      )}
    </li>
  );
}

function AgentRow({ agent, workflows }: { agent: Subagent; workflows: WorkflowRun[] }): JSX.Element {
  const run = agent.workflowRunId ? workflows.find((w) => w.runId === agent.workflowRunId) : undefined;
  return (
    <li class="agent">
      <span class={agent.finished ? 'agent-mark agent-done' : 'agent-mark agent-running'}>
        {agent.finished ? <Icon name="check" label="Finished" /> : <span class="dot dot-busy" role="img" aria-label="Running" />}
      </span>
      <span class="agent-text">
        <span class="agent-desc">{agent.description}</span>
        <span class="agent-facts">
          <span>{agent.agentType}</span>
          {agent.model && <span>{agent.model}</span>}
          {agent.workflowRunId && <span title={agent.workflowRunId}>in {run?.name ?? agent.workflowRunId}</span>}
          {agent.updatedAt !== undefined && <Ago at={agent.updatedAt} long />}
        </span>
      </span>
    </li>
  );
}

export function Detail({ session: s, onClose }: { session: ClaudeSession; onClose: () => void }): JSX.Element {
  const { state, post } = useCockpit();
  const dialog = useRef<HTMLDivElement>(null);
  const project = state.projects.find((p) => p.key === s.projectKey);
  const running = s.subagents.filter((a) => !a.finished);
  // Running first, then the newest.
  const agents = [...s.subagents].sort((a, b) => Number(a.finished) - Number(b.finished) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));

  useEffect(() => {
    dialog.current?.focus();
  }, [s.sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Paths and ids in the editor font, so they read (and copy) exactly.
  const facts: { label: string; value: JSX.Element | string | undefined; mono?: boolean }[] = [
    { label: 'Project', value: project?.name },
    { label: 'Folder', value: s.cwd, mono: true },
    { label: 'Branch', value: s.gitBranch, mono: true },
    { label: 'Name', value: s.name, mono: true },
    { label: 'Started', value: s.startedAt !== undefined ? fullDate(s.startedAt) : undefined },
    { label: 'Last activity', value: s.updatedAt !== undefined ? <Ago at={s.updatedAt} long /> : undefined },
    { label: 'Agent', value: providerLabel(s.provider, state.settings.customAgents) },
    { label: 'Version', value: s.agentVersion ?? s.claudeVersion, mono: true },
    { label: 'Status detail', value: s.statusNote },
    { label: 'Process', value: s.pid !== undefined ? String(s.pid) : undefined, mono: true },
    { label: 'Session ID', value: s.sessionId, mono: true },
    { label: 'Transcript', value: s.transcriptPath, mono: true },
  ];

  return (
    <div class="drawer-layer">
      <div class="drawer-backdrop" onClick={onClose} />
      <div class="drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title" tabIndex={-1} ref={dialog}>
        <header class="drawer-head">
          <div class="drawer-status">
            <StatusDot status={s.status} decorative />
            <span>{statusText(s)}</span>
            {s.updatedAt !== undefined && (
              <span class="muted">
                · <Ago at={s.updatedAt} long />
              </span>
            )}
          </div>
          <h2 id="detail-title">{s.title}</h2>
          <button type="button" class="btn btn-icon drawer-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>

        <div class="drawer-actions">
          {!s.live && s.canResume !== false && providerFor(s.provider, state.settings.customAgents)?.resumeArgs && (
            <button type="button" class="btn btn-primary" onClick={() => post({ type: 'resumeSession', sessionId: s.sessionId })}>
              <Icon name="play" /> Resume
            </button>
          )}
          {s.inVsCodeTerminal && (
            <button type="button" class="btn btn-primary" onClick={() => post({ type: 'focusSession', sessionId: s.sessionId })}>
              <Icon name="terminal" /> Focus terminal
            </button>
          )}
          <button type="button" class="btn" onClick={() => post({ type: 'openFolder', path: s.cwd, newWindow: true })}>
            <Icon name="folder" /> Open worktree
          </button>
          {s.transcriptPath && (
            <button type="button" class="btn" onClick={() => post({ type: 'openTranscript', sessionId: s.sessionId })}>
              <Icon name="file" /> Open transcript
            </button>
          )}
          <button type="button" class="btn" onClick={() => post({ type: 'copy', text: s.sessionId })}>
            <Icon name="copy" /> Copy ID
          </button>
        </div>

        <div class="drawer-body">
          <section aria-labelledby="detail-prompts">
            <h3 id="detail-prompts">Recent prompts</h3>
            {s.recentPrompts.length > 0 ? (
              <ol class="prompts">
                {s.recentPrompts.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            ) : (
              <Empty>No prompt recorded yet.</Empty>
            )}
          </section>

          {s.report && (
            <section aria-labelledby="detail-report">
              <h3 id="detail-report">Last answer</h3>
              <Report text={s.report} lane={laneOf(state, state.work.items.find((i) => i.sessionIds.includes(s.sessionId))?.branch)} />
            </section>
          )}

          {s.workflows.length > 0 && (
            <section aria-labelledby="detail-workflows">
              <h3 id="detail-workflows">
                Workflows <span class="count">{s.workflows.length}</span>
              </h3>
              <ul class="workflows">
                {s.workflows.map((w) => (
                  <Workflow key={w.runId} run={w} />
                ))}
              </ul>
            </section>
          )}

          {agents.length > 0 && (
            <section aria-labelledby="detail-agents">
              <h3 id="detail-agents">
                Subagents <span class="count">{agents.length}</span>
                {running.length > 0 && <span class="muted"> · {running.length} running</span>}
              </h3>
              <ul class="agents">
                {agents.map((a) => (
                  <AgentRow key={a.id} agent={a} workflows={s.workflows} />
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="detail-facts">
            <h3 id="detail-facts">Details</h3>
            <dl class="facts">
              {facts
                .filter((f) => f.value !== undefined)
                .map((f) => (
                  <div key={f.label} class="fact">
                    <dt>{f.label}</dt>
                    <dd class={f.mono ? 'mono' : undefined}>{f.value}</dd>
                  </div>
                ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}
