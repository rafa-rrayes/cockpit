// Every Claude session on the machine, grouped by project: the workspace's project first and open, the others
// folded under their names with a count and their status dots. With "Show all active projects" off (the
// cockpit.claudes.showAllProjects setting), only the workspace project's sessions, as cards with no group head.
import type { JSX } from 'preact';
import type { ClaudeSession, Project, SessionStatus } from '../../src/model';
import { type SessionFilter, useCockpit } from '../context';
import { baseName, plural } from '../format';
import { Icon } from '../icons';
import { Ago, Chip, Empty, Section, StatusDot, statusText, statusWord } from '../ui';

const matches = (s: ClaudeSession, filter: SessionFilter, showEnded: boolean): boolean => {
  if (filter === 'waiting') return s.status === 'waiting';
  if (filter === 'live') return s.live;
  return s.live || showEnded;
};

// Order inside a summary: what needs a look first.
const statusOrder: SessionStatus[] = ['waiting', 'busy', 'unknown', 'idle', 'ended'];

function summary(sessions: ClaudeSession[]): string {
  return statusOrder
    .map((st) => [st, sessions.filter((s) => s.status === st).length] as const)
    .filter(([, n]) => n > 0)
    .map(([st, n]) => `${n} ${statusWord[st].toLowerCase()}`)
    .join(', ');
}

export function SessionCard({ session: s }: { session: ClaudeSession }): JSX.Element {
  const { openSession } = useCockpit();
  const running = s.subagents.filter((a) => !a.finished).length;
  const done = s.subagents.length - running;
  const worktree = s.cwd !== s.projectKey ? baseName(s.cwd) : undefined;
  const shownWorkflows = s.workflows.slice(0, 2);

  return (
    <button type="button" class={`card card-${s.status}`} data-session={s.sessionId} onClick={() => openSession(s.sessionId)}>
      <span class="card-top">
        <StatusDot status={s.status} decorative />
        <span class="card-status">{statusText(s)}</span>
        <Ago at={s.updatedAt} />
      </span>
      <span class="card-title">{s.title}</span>
      <span class="card-meta">
        {s.gitBranch && (
          <span class="meta-item" title={`Branch ${s.gitBranch}`}>
            <Icon name="branch" />
            <span class="mono">{s.gitBranch}</span>
          </span>
        )}
        {worktree && (
          <span class="meta-item" title={`Worktree ${s.cwd}`}>
            <Icon name="folder" />
            {worktree}
          </span>
        )}
        {s.inVsCodeTerminal && (
          <span class="meta-item" title="Runs in a terminal of this window">
            <Icon name="terminal" />
            here
          </span>
        )}
      </span>
      {s.lastPrompt && <span class="card-prompt">{s.lastPrompt}</span>}
      {(s.subagents.length > 0 || s.workflows.length > 0) && (
        <span class="chips">
          {running > 0 && (
            <Chip tone="info" icon="agent">
              {plural(running, 'agent')} running
            </Chip>
          )}
          {done > 0 && (
            <Chip icon="agent">
              {done} done
            </Chip>
          )}
          {shownWorkflows.map((w) => (
            <Chip key={w.runId} tone={w.status === 'running' ? 'info' : w.status === 'failed' ? 'fail' : 'muted'} icon="workflow" title={w.summary ?? w.runId}>
              {w.name ?? 'Workflow'} · {w.status}
            </Chip>
          ))}
          {s.workflows.length > shownWorkflows.length && <Chip>+{s.workflows.length - shownWorkflows.length}</Chip>}
        </span>
      )}
    </button>
  );
}

function ProjectGroup({ project, sessions, defaultOpen }: { project: Project; sessions: ClaudeSession[]; defaultOpen: boolean }): JSX.Element {
  const { ui, update } = useCockpit();
  const open = ui.open[project.key] ?? defaultOpen;
  const panelId = `project-${encodeURIComponent(project.key)}`;
  const toggle = (): void => update((prev) => ({ open: { ...prev.open, [project.key]: !open } }));

  return (
    <div class={open ? 'group group-open' : 'group'}>
      <h3 class="group-head">
        <button type="button" class="group-toggle" aria-expanded={open} aria-controls={panelId} onClick={toggle}>
          <Icon name="chevron" class="chevron" />
          <span class="group-name">{project.name}</span>
          {project.isWorkspace && <span class="tag">this window</span>}
          <span class="count">{sessions.length}</span>
          <span class="group-dots" aria-hidden="true">
            {sessions.slice(0, 12).map((s) => (
              <span key={s.sessionId} class={`dot dot-small dot-${s.status}`} />
            ))}
          </span>
          <span class="group-summary">{summary(sessions)}</span>
        </button>
      </h3>
      {open && (
        <div class="cards" id={panelId}>
          {sessions.map((s) => (
            <SessionCard key={s.sessionId} session={s} />
          ))}
        </div>
      )}
    </div>
  );
}

export function Claudes(): JSX.Element {
  const { state, ui, update, post } = useCockpit();
  const workspaceProject = state.projects.find((p) => p.isWorkspace);
  // Off only means something in a window with a project: an empty window shows every project.
  const onlyHere = !state.settings.showAllProjects && state.workspace !== undefined;
  const all = onlyHere
    ? (workspaceProject?.sessionIds ?? []).map((id) => state.sessions[id]).filter((s): s is ClaudeSession => s !== undefined)
    : Object.values(state.sessions);
  const live = all.filter((s) => s.live).length;
  const waiting = all.filter((s) => s.status === 'waiting').length;
  const ended = all.length - live;
  const shown = (p: Project): ClaudeSession[] =>
    p.sessionIds.map((id) => state.sessions[id]).filter((s): s is ClaudeSession => s !== undefined && matches(s, ui.filter, ui.showEnded));

  const groups = state.projects.map((p) => ({ project: p, sessions: shown(p) })).filter((g) => g.project.isWorkspace || g.sessions.length > 0);

  const filters: { id: SessionFilter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: ui.showEnded ? all.length : live },
    { id: 'live', label: 'Live', n: live },
    { id: 'waiting', label: 'Waiting', n: waiting },
  ];

  const emptyHere = ui.filter === 'waiting' ? 'No Claude here is waiting for you.' : 'No Claude is running here.';

  let body: JSX.Element | JSX.Element[];
  if (onlyHere) {
    const here = workspaceProject ? shown(workspaceProject) : [];
    body = here.length ? (
      <div class="cards">
        {here.map((s) => (
          <SessionCard key={s.sessionId} session={s} />
        ))}
      </div>
    ) : (
      <Empty>{emptyHere}</Empty>
    );
  } else {
    const hasWorkspaceProject = workspaceProject !== undefined;
    body = [
      ...(!hasWorkspaceProject && state.workspace ? [<Empty key="empty-here">{emptyHere}</Empty>] : []),
      ...(groups.length === 0 && !state.workspace ? [<Empty key="empty">No Claude session on this machine yet.</Empty>] : []),
      ...groups.map(({ project, sessions }) =>
        project.isWorkspace && sessions.length === 0 ? (
          <div class="group group-open" key={project.key}>
            <h3 class="group-head group-head-static">
              <span class="group-name">{project.name}</span>
              <span class="tag">this window</span>
            </h3>
            <Empty>{emptyHere}</Empty>
          </div>
        ) : (
          <ProjectGroup
            key={project.key}
            project={project}
            sessions={sessions}
            defaultOpen={project.isWorkspace || (!hasWorkspaceProject && sessions.some((s) => s.live))}
          />
        ),
      ),
    ];
  }

  return (
    <Section
      id="claudes"
      title="Claudes"
      meta={`${live} live`}
      actions={
        <>
          <span class="segmented" role="group" aria-label="Show sessions">
            {filters.map((f) => (
              <button type="button" key={f.id} aria-pressed={ui.filter === f.id} onClick={() => update({ filter: f.id })}>
                {f.label} <span class="count">{f.n}</span>
              </button>
            ))}
          </span>
          <label class="check">
            <input
              type="checkbox"
              checked={ui.showEnded}
              disabled={ui.filter !== 'all'}
              onChange={(e) => update({ showEnded: e.currentTarget.checked })}
            />
            Show ended <span class="count">{ended}</span>
          </label>
          {state.workspace && (
            <label class="check" title="Off: only the Claudes of this window's project">
              <input
                type="checkbox"
                checked={state.settings.showAllProjects}
                onChange={(e) => post({ type: 'setSetting', edit: { key: 'claudes.showAllProjects', value: e.currentTarget.checked } })}
              />
              Show all active projects
            </label>
          )}
        </>
      }
    >
      {body}
    </Section>
  );
}
