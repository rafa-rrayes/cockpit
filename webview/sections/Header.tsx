// The sticky top bar, one compact row: where you are, a jump list for the sections, what is running at a glance,
// Refresh, Maximize and the settings popover.
import type { JSX } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { catchUp } from '../../src/catchup';
import type { SectionId, SessionStatus } from '../../src/model';
import { useCockpit } from '../context';
import { Icon } from '../icons';
import { Ago, useDismiss } from '../ui';
import { SettingsPopover } from './Settings';

/** The keybinding package.json gives cockpit.maximize. */
const MAXIMIZE_KEYS = /Mac/.test(navigator.userAgent) ? '⌃⌘M' : 'Ctrl+Alt+M';

const jump = (id: string): void => {
  const target = document.getElementById(id);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  const heading = target.querySelector<HTMLElement>('h2');
  heading?.setAttribute('tabindex', '-1');
  heading?.focus({ preventScroll: true });
};

export function Header(): JSX.Element {
  const { state, post, openCatchUp } = useCockpit();
  const news = catchUp(state).length;
  const sessions = Object.values(state.sessions);
  const count = (status: SessionStatus): number => sessions.filter((s) => s.status === status).length;
  const working = count('busy');
  const waiting = count('waiting');
  const idle = count('idle');

  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRoot = useRef<HTMLSpanElement>(null);
  const settingsButton = useRef<HTMLButtonElement>(null);
  useDismiss(settingsRoot, settingsOpen, (byKey) => {
    setSettingsOpen(false);
    if (byKey) settingsButton.current?.focus();
  });
  const hidden = new Set(state.settings.hiddenSections);

  const nav: { id: SectionId; label: string; show: boolean; badge?: number }[] = [
    { id: 'needs', label: 'Needs you', show: state.attention.length > 0, badge: state.attention.length },
    { id: 'claudes', label: 'Agents', show: true },
    { id: 'roadmap', label: 'Roadmap', show: Boolean(state.releases.roadmapPath) },
    { id: 'work', label: 'Work', show: state.work.available },
    { id: 'releases', label: 'Releases', show: state.releases.available },
    { id: 'activity', label: 'Activity', show: true },
  ];

  return (
    <header class="topbar">
      <div class="topbar-row">
        <h1 class="brand" title={state.workspace?.path}>
          {state.workspace?.name ?? 'Cockpit'}
        </h1>
        <nav class="jump" aria-label="Sections">
          {nav
            .filter((n) => n.show && !hidden.has(n.id))
            .map((n) => (
              <button type="button" key={n.id} class={n.badge ? 'jump-link jump-attention' : 'jump-link'} onClick={() => jump(n.id)}>
                {n.label}
                {n.badge !== undefined && n.badge > 0 && <span class="badge">{n.badge}</span>}
              </button>
            ))}
        </nav>
        <p class="pulse" aria-label="Agent sessions right now">
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
        <button
          type="button"
          class={news ? 'btn btn-small catchup-button catchup-new' : 'btn btn-small catchup-button'}
          title="What finished, waits or changed since you last looked"
          aria-haspopup="dialog"
          onClick={openCatchUp}
        >
          Catch up
          {news > 0 && <span class="badge">{news}</span>}
        </button>
        <span class="topbar-end">
          <span class="updated">
            Updated <Ago at={state.generatedAt} long />
          </span>
          <button type="button" class="btn btn-icon" title="Refresh" aria-label="Refresh" onClick={() => post({ type: 'refresh' })}>
            <Icon name="refresh" />
          </button>
          <button type="button" class="btn btn-icon" title={`Maximize: close the side bars and the panel (${MAXIMIZE_KEYS})`} aria-label="Maximize" onClick={() => post({ type: 'maximize' })}>
            <Icon name="maximize" />
          </button>
          <span class="set-anchor" ref={settingsRoot}>
            <button
              ref={settingsButton}
              type="button"
              class="btn btn-icon"
              title="Settings"
              aria-label="Settings"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
              onClick={() => setSettingsOpen((o) => !o)}
            >
              <Icon name="settings" />
            </button>
            {settingsOpen && <SettingsPopover />}
          </span>
        </span>
      </div>
    </header>
  );
}
