// Browser preview only: the messages the page would have sent to the extension host.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { clockTime } from '../format';
import { type DevLogEntry, host } from '../host';

export function DevLog(): JSX.Element {
  const [entries, setEntries] = useState<DevLogEntry[]>([]);
  useEffect(() => host.onDevLog(setEntries), []);
  return (
    <aside class="devlog" aria-label="Messages to the extension host (browser preview)">
      <span class="devlog-title">Preview · posted to host</span>
      <ol>
        {entries.map((e, i) => {
          const { type: t, ...args } = e.message;
          return (
            <li key={i}>
              <span class="muted">{clockTime(e.at)}</span> <b>{t}</b> {Object.keys(args).length > 0 && <code>{JSON.stringify(args)}</code>}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
