// The sticky top bar: where you are, what is running at a glance, a jump list for the sections, Refresh.
import type { JSX } from 'preact';
import type { SessionStatus } from '../../src/model';
import { useCockpit } from '../context';
import { Icon } from '../icons';
import { Ago } from '../ui';

const jump = (id: string): void => {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const heading = target.querySelector<HTMLElement>('h2');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
};

export function Header(): JSX.Element {
  const { state, post } = useCockpit();
  const sessions = Object.values(state.sessions);
  const count = (status: SessionStatus): number => sessions.filter((s) => s.status === status).length;
  const working = count('busy');
  const waiting = count('waiting');
  const idle = count('idle');

  const nav: { id: string; label: string; show: boolean; badge?: number }[] = [
    { id: 'needs', label: 'Needs you', show: state.attention.length > 0, badge: state.attention.length },
    { id: 'claudes', label: 'Claudes', show: true },
    { id: 'roadmap', label: 'Roadmap', show: Boolean(state.releases.roadmapPath) },
    { id: 'work', label: 'Work', show: state.work.available },
    { id: 'releases', label: 'Releases', show: state.releases.available },
    { id: 'activity', label: 'Activity', show: true },
  ];

  return (
    <header class="topbar">
      <div class="topbar-row">
        <div class="brand">
          <h1>{state.workspace?.name ?? 'Cockpit'}</h1>
          {state.workspace && (
            <span class="brand-path" title={state.workspace.path}>
              {state.workspace.path}
            </span>
          )}
        </div>
        <p class="pulse" aria-label="Claude sessions right now">
          <span class="pulse-item">
            <span class="dot dot-busy" aria-hidden="true" />
            {working} working
          </span>
          <span class={waiting ? 'pulse-item pulse-waiting' : 'pulse-item'}>
            <span class="dot dot-waiting" aria-hidden="true" />
            {waiting} waiting
          </span>
          <span class="pulse-item">
            <span class="dot dot-idle" aria-hidden="true" />
            {idle} idle
          </span>
        </p>
        <span class="topbar-end">
          <span class="updated">
            Updated <Ago at={state.generatedAt} long />
          </span>
          <button type="button" class="btn btn-icon" title="Refresh" aria-label="Refresh" onClick={() => post({ type: 'refresh' })}>
            <Icon name="refresh" />
          </button>
        </span>
      </div>
      <nav class="jump" aria-label="Sections">
        {nav
          .filter((n) => n.show)
          .map((n) => (
            <button type="button" key={n.id} class={n.badge ? 'jump-link jump-attention' : 'jump-link'} onClick={() => jump(n.id)}>
              {n.label}
              {n.badge !== undefined && n.badge > 0 && <span class="badge">{n.badge}</span>}
            </button>
          ))}
      </nav>
    </header>
  );
}
