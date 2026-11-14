// Time and number formatting, and the shared clock that keeps "12m ago" current between State updates.
import { useEffect, useState } from 'preact/hooks';

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
document.addEventListener('visibilitychange', () => {
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
