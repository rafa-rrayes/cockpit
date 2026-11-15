// A Claude's report, readable: the few markdown blocks a report uses (headings, lists, code blocks, paragraphs) and
// inline code and bold, built as elements, never as HTML, so nothing in a transcript can run in the page. Under its
// "still open" list, each item can become a card in the session's lane.
import type { ComponentChildren, JSX } from 'preact';
import { useState } from 'preact/hooks';
import { stillOpen } from '../src/catchup';
import { useCockpit } from './context';
import { Icon } from './icons';

/** `code` and **bold** inside a line; links keep their text. */
function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\([^)]*\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    if (m[1] !== undefined) out.push(<code>{m[1]}</code>);
    else if (m[2] !== undefined) out.push(<strong>{m[2]}</strong>);
    else out.push(m[3]);
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: 'h'; text: string } | { kind: 'ul' | 'ol'; items: string[] } | { kind: 'code'; text: string } | { kind: 'p'; text: string };

const LIST = /^\s*(?:([-*+])|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

function blocks(text: string): Block[] {
  const out: Block[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    if (/^\s*(```|~~~)/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^\s*(```|~~~)/.test(lines[i] ?? ''); i++) body.push(lines[i] ?? '');
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    const h = /^#{1,6}\s+(.*)$/.exec(line.trim());
    if (h) {
      out.push({ kind: 'h', text: h[1] ?? '' });
      continue;
    }
    const item = LIST.exec(line);
    if (item) {
      const kind = item[1] ? 'ul' : 'ol';
      const items = [item[2] ?? ''];
      // Wrapped and nested lines join their item.
      while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() && (LIST.test(lines[i + 1] ?? '') || /^\s+\S/.test(lines[i + 1] ?? ''))) {
        i++;
        const next = lines[i] ?? '';
        const m = LIST.exec(next);
        if (m && !/^\s/.test(next)) items.push(m[2] ?? '');
        else items[items.length - 1] += ` ${(m?.[2] ?? next).trim()}`;
      }
      out.push({ kind, items });
      continue;
    }
    const para = [line.trim()];
    while (i + 1 < lines.length && (lines[i + 1] ?? '').trim() && !LIST.test(lines[i + 1] ?? '') && !/^#{1,6}\s|^\s*(```|~~~)/.test(lines[i + 1] ?? '')) para.push((lines[++i] ?? '').trim());
    out.push({ kind: 'p', text: para.join(' ') });
  }
  return out;
}

function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <div class="report-text">
      {blocks(text).map((b, i) => {
        if (b.kind === 'h') return <h4 key={i}>{inline(b.text)}</h4>;
        if (b.kind === 'code') return <pre key={i}>{b.text}</pre>;
        if (b.kind === 'p') return <p key={i}>{inline(b.text)}</p>;
        const List = b.kind;
        return (
          <List key={i}>
            {b.items.map((it, j) => (
              <li key={j}>{inline(it)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

/** The report, and its open items with "Add as card" into `lane`. */
export function Report({ text, lane }: { text: string; lane: string }): JSX.Element {
  const { state, post } = useCockpit();
  const open = stillOpen(text);
  // Added from here a moment ago, or already a card of the lane: either way not offered again.
  const [added, setAdded] = useState<string[]>([]);
  const onBoard = new Set(state.releases.roadmap.find((l) => l.version === lane)?.items.map((i) => i.text) ?? []);
  return (
    <div class="report">
      <Markdown text={text} />
      {open.length > 0 && (
        <div class="report-open">
          <h4>Left open, as cards for {lane}</h4>
          <ul>
            {open.map((item) => (
              <li key={item}>
                <span>{item}</span>
                {added.includes(item) || onBoard.has(item) ? (
                  <span class="muted">on the board</span>
                ) : (
                  <button
                    type="button"
                    class="btn btn-small"
                    onClick={() => {
                      post({ type: 'roadmap', edit: { op: 'add', lane, text: item } });
                      setAdded((a) => [...a, item]);
                    }}
                  >
                    <Icon name="plus" /> Add as card
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
