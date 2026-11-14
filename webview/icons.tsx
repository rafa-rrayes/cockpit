// A small set of 16px line icons drawn in currentColor, so they follow the theme like codicons do (the webview
// cannot load the codicon font without shipping it).
import type { JSX } from 'preact';

// A full circle as a path: two half arcs from the top to the bottom and back.
const c = (cx: number, cy: number, r: number): string => `M${cx} ${cy - r}a${r} ${r} 0 1 0 0 ${2 * r}a${r} ${r} 0 1 0 0 ${-2 * r}`;

const paths = {
  branch: `M5 4.5v7${c(5, 3, 1.5)}${c(5, 13, 1.5)}${c(11, 4.5, 1.5)}M11 6c0 3-6 2-6 5`,
  folder: 'M2 4.5h4l1.5 1.5H14v6.5H2z',
  commit: `M1.5 8h4M10.5 8h4${c(8, 8, 2.5)}`,
  play: 'M5 3.5l7 4.5-7 4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  check: 'M3.5 8.5l3 3 6-7',
  x: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  clock: `${c(8, 8, 5.5)}M8 5v3.2l2 1.3`,
  pr: `M4.5 4.5v7${c(4.5, 3, 1.5)}${c(4.5, 13, 1.5)}${c(11.5, 13, 1.5)}M11.5 11.5V6.5a2 2 0 0 0-2-2H7M8.5 3L7 4.5 8.5 6`,
  ci: `M8 1.8l1 1.9 2.1-.4.4 2.1 1.9 1-1 1.9 1 1.6-1.9 1-.4 2.1-2.1-.4-1 1.9-1-1.9-2.1.4-.4-2.1-1.9-1 1-1.6-1-1.9 1.9-1 .4-2.1 2.1.4z${c(8, 8, 2)}`,
  chevron: 'M6 4l4 4-4 4',
  refresh: 'M13 3v3.5H9.5M12.6 6.5A5 5 0 1 0 13 9.5',
  terminal: 'M2 3h12v10H2zM4.5 6l2 2-2 2M8 10.5h3.5',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
  file: 'M4 1.8h5l3 3v9.4H4zM9 1.8v3h3',
  agent: 'M5 6.5a3 3 0 0 1 6 0v2.5a3 3 0 0 1-6 0zM3 8h2M11 8h2M8 3.5V2M6.5 7.5v.5M9.5 7.5v.5',
  workflow: 'M2.5 3h4v3h-4zM9.5 10h4v3h-4zM4.5 6v4h5M9.5 3h4v3h-4zM11.5 6v4',
  tag: `M2 2.5h5.5l6.5 6.5-5 5-6.5-6.5z${c(5, 5.5, 0.6)}`,
  close: 'M4 4l8 8M12 4l-8 8',
  person: `${c(8, 5, 2.5)}M3 13.5c.5-2.5 2.5-4 5-4s4.5 1.5 5 4`,
  merge: `M4.5 4.5v7${c(4.5, 3, 1.5)}${c(4.5, 13, 1.5)}${c(11.5, 10, 1.5)}M4.5 5.5c0 3 3 4.5 5.5 4.5`,
} as const;

export type IconName = keyof typeof paths;

interface IconProps {
  name: IconName;
  /** Accessible name; without one the icon is decorative and hidden from screen readers. */
  label?: string;
  class?: string;
}

export function Icon({ name, label, class: cls }: IconProps): JSX.Element {
  return (
    <svg
      class={cls ? `icon ${cls}` : 'icon'}
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.3"
      stroke-linecap="round"
      stroke-linejoin="round"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : 'true'}
    >
      <path d={paths[name]} />
    </svg>
  );
}
