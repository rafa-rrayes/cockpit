// Time and number formatting, and the shared clock that keeps "12m ago" current between State updates.
import { useEffect, useState } from 'preact/hooks';
import type { Work } from '../src/model';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "45s", "12m", "3h", "5d", "8 Nov": short enough for a card corner. */
export function since(at: number, now: number): string {
  const d = Math.max(0, now - at);
  if (d < 5_000) return 'now';
  if (d < MINUTE) return `${Math.floor(d / 1000)}s`;
  if (d < HOUR) return `${Math.floor(d / MINUTE)}m`;
  if (d < DAY) return `${Math.floor(d / HOUR)}h`;
  if (d < 14 * DAY) return `${Math.floor(d / DAY)}d`;
  return new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const sinceLong = (at: number, now: number): string => {
  const s = since(at, now);
  return s === 'now' ? 'just now' : /^\d+[smhd]$/.test(s) ? `${s} ago` : s;
};

export const clockTime = (at: number): string =>
  new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

export const fullDate = (at: number): string =>
  new Date(at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

const startOfDay = (at: number): number => {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** A day heading for the activity timeline: "Today", "Yesterday", "Monday 10 November". */
export function dayLabel(at: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return new Date(at).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

export const dayKey = (at: number): number => startOfDay(at);

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** The last path segment, for compact labels: "/a/b/harbor-wt/feat-x" → "feat-x". */
export const baseName = (path: string): string => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path;

// ───────────────────────────── Actions as the delivery mode has them ─────────────────────────────

/** A button's face: what it says, its icon and the tooltip saying exactly what it does. */
export interface ActionFace {
  label: string;
  /** Names from icons.tsx, which this file cannot import: the unit tests compile it without JSX. */
  icon: 'merge' | 'pr' | 'tag';
  title: string;
}

const baseOf = (work: Work): string => work.defaultBranch ?? 'the default branch';

/** The button that finishes a branch: "Merge into main…" in direct delivery, "Ship…" with pull requests. Work, Catch
 *  up and the roadmap cards all use it, so the three places say the same thing. */
export function finishAction(work: Work, branch: string): ActionFace {
  if (work.delivery === 'direct') {
    const base = baseOf(work);
    return {
      label: work.defaultBranch ? `Merge into ${work.defaultBranch}…` : 'Merge…',
      icon: 'merge',
      title: `Merges ${branch} into ${base} in the main checkout${work.hasOrigin ? ` and pushes ${base} to origin` : ''}, then marks its cards done, after a confirmation`,
    };
  }
  return { label: 'Ship…', icon: 'pr', title: `Pushes ${branch} and opens its pull request, after showing both` };
}

/** A release lane's step button: prepare the release, or tag it. */
export function releaseAction(work: Work, version: string, step: 'release' | 'tag'): ActionFace {
  const tag = `v${version}`;
  if (work.delivery === 'direct') {
    const base = baseOf(work);
    if (step === 'tag') return { label: `Tag ${tag}…`, icon: 'tag', title: `Tags the tip of ${base} as ${tag}${work.hasOrigin ? ' and pushes the tag' : ''}, after a confirmation` };
    return {
      label: `Release ${version}…`,
      icon: 'tag',
      title: `Bumps the version, dates the changelog, commits on ${base} and tags ${tag}${work.hasOrigin ? ', then pushes both' : ''}, after a confirmation`,
    };
  }
  if (step === 'tag') return { label: `Tag ${tag}…`, icon: 'tag', title: 'Tags the merged release and pushes the tag, after a confirmation' };
  return { label: `Release ${version}…`, icon: 'tag', title: 'Prepares the release pull request (version, changelog), after showing it' };
}

/** How finished work reaches the default branch, for the Work header: "direct · local", "direct · origin",
 *  "pull requests · owner/repo". */
export function deliveryText(work: Work): { text: string; title: string } {
  const base = baseOf(work);
  const how = 'Set "delivery" in .cockpit/config.json: auto, direct or pr.';
  if (work.delivery === 'direct') {
    return work.hasOrigin
      ? { text: 'direct · origin', title: `Branches merge into ${base} in the main checkout, which is then pushed to origin. ${how}` }
      : { text: 'direct · local', title: `Branches merge into ${base} in the main checkout; nothing leaves this machine. ${how}` };
  }
  return { text: `pull requests · ${work.github ?? 'origin'}`, title: `Branches reach ${base} through GitHub pull requests. ${how}` };
}

// One timer for the whole page. It ticks every second only while the page is visible.
type Tick = (now: number) => void;
const ticks = new Set<Tick>();
let timer: ReturnType<typeof setInterval> | undefined;

const startClock = (): void => {
  if (timer !== undefined || document.hidden || ticks.size === 0) return;
  timer = setInterval(() => {
    const now = Date.now();
    for (const tick of ticks) tick(now);
  }, 1000);
};
const stopClock = (): void => {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
};
// Guarded so the formatting helpers above can be imported by the unit tests, which run in node.
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopClock();
  else {
    const now = Date.now();
    for (const tick of ticks) tick(now);
    startClock();
  }
});

/** The current time, re-rendering the caller every second while the page is visible. */
export function useNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    ticks.add(setNow);
    startClock();
    return () => {
      ticks.delete(setNow);
      if (ticks.size === 0) stopClock();
    };
  }, []);
  return now;
}
