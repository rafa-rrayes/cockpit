// The roadmap as a board: a lane per release (and the backlog), a column per status. Every change is posted to
// the host, which edits ROADMAP.md; the board redraws from the State that comes back.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ItemStatus, ReleasePlan, RoadmapEdit, RoadmapItem } from '../../src/model';
import { nextMinor } from '../../src/data/roadmap';
import { useCockpit } from '../context';
import { Icon } from '../icons';
import { Chip, Section } from '../ui';

const COLUMNS: { status: ItemStatus; label: string }[] = [
  { status: 'todo', label: 'Planned' },
  { status: 'doing', label: 'In progress' },
  { status: 'done', label: 'Done' },
];

function statusTone(status: string): 'ok' | 'info' | 'muted' {
  const s = status.toLowerCase();
  if (s.includes('ship') || s.includes('done') || s.includes('released')) return 'ok';
  if (s.includes('progress') || s.includes('active')) return 'info';
  return 'muted';
}

const laneLabel = (lane: ReleasePlan): string => (lane.backlog || !lane.title ? lane.version : `${lane.version} ${lane.title}`);

interface Drop {
  lane: string;
  status: ItemStatus;
  /** The card the dragged one would go before; absent: the end of the lane. */
  before?: string;
}

/** A one-line text field: Enter commits, Escape cancels, leaving it commits what was typed. */
function LineInput(props: { initial?: string; label: string; placeholder?: string; keepOpen?: boolean; onCommit(text: string): void; onClose(): void }): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const commit = (close: boolean): void => {
    const text = ref.current?.value.trim() ?? '';
    if (text && text !== (props.initial ?? '')) props.onCommit(text);
    if (close || !text) {
      settled.current = true;
      props.onClose();
    } else if (ref.current) ref.current.value = '';
  };
  return (
    <input
      ref={ref}
      class="rm-input"
      type="text"
      maxLength={300}
      defaultValue={props.initial ?? ''}
      placeholder={props.placeholder}
      aria-label={props.label}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit(!props.keepOpen);
        else if (e.key === 'Escape') {
          settled.current = true;
          props.onClose();
        }
      }}
      onBlur={() => {
        if (!settled.current) commit(true);
      }}
    />
  );
}

interface CardProps {
  item: RoadmapItem;
  lane: ReleasePlan;
  lanes: ReleasePlan[];
  dragging: boolean;
  dropBefore: boolean;
  edit(e: RoadmapEdit): void;
  onDragStart(id: string): void;
  onDragEnd(): void;
  onDragOver(drop: Drop): void;
  onDrop(drop: Drop): void;
}

function Card({ item, lane, lanes, dragging, dropBefore, edit, onDragStart, onDragEnd, onDragOver, onDrop }: CardProps): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const root = useRef<HTMLLIElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  // The menu closes on a click anywhere else and on Escape, which hands focus back to its button.
  useEffect(() => {
    if (!menu) return;
    const outside = (e: MouseEvent): void => {
      if (e.target instanceof Node && !root.current?.contains(e.target)) setMenu(false);
    };
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setMenu(false);
      menuButton.current?.focus();
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', key);
    };
  }, [menu]);

  const pick = (e: RoadmapEdit): void => {
    setMenu(false);
    edit(e);
  };

  const cls = ['rm-card', `rm-${item.status}`, dragging && 'rm-dragging', dropBefore && 'rm-drop-before'].filter(Boolean).join(' ');
  return (
    <li
      ref={root}
      class={cls}
      draggable={!renaming}
      onDragStart={(e) => {
        e.dataTransfer?.setData('text/plain', item.text);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
        onDragStart(item.id);
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDragOver({ lane: lane.version, status: item.status, before: item.id });
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onDrop({ lane: lane.version, status: item.status, before: item.id });
      }}
    >
      {renaming ? (
        <LineInput initial={item.text} label="Card text" onCommit={(text) => edit({ op: 'setText', id: item.id, text })} onClose={() => setRenaming(false)} />
      ) : (
        <span class="rm-text" onDblClick={() => setRenaming(true)} title="Double-click to rename">
          {item.text}
        </span>
      )}
      {!renaming && (
        <button ref={menuButton} type="button" class="btn-icon rm-menu-button" aria-haspopup="menu" aria-expanded={menu} aria-label={`Actions for ${item.text}`} onClick={() => setMenu((open) => !open)}>
          <Icon name="more" />
        </button>
      )}
      {menu && (
        <div class="rm-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(false);
              setRenaming(true);
            }}
          >
            Rename
          </button>
          <hr />
          {COLUMNS.filter((c) => c.status !== item.status).map((c) => (
            <button key={c.status} type="button" role="menuitem" onClick={() => pick({ op: 'setStatus', id: item.id, status: c.status })}>
              Mark {c.label.toLowerCase()}
            </button>
          ))}
          <hr />
          {lanes
            .filter((l) => l.version !== lane.version)
            .map((l) => (
              <button key={l.version} type="button" role="menuitem" onClick={() => pick({ op: 'move', id: item.id, lane: l.version, status: item.status })}>
                Move to {laneLabel(l)}
              </button>
            ))}
          <hr />
          <button type="button" role="menuitem" class="rm-danger" onClick={() => pick({ op: 'remove', id: item.id })}>
            Delete…
          </button>
        </div>
      )}
    </li>
  );
}

function LaneHead({ lane }: { lane: ReleasePlan }): JSX.Element {
  const total = lane.items.length;
  const done = lane.items.filter((i) => i.status === 'done').length;
  return (
    <header class="rm-lane-head">
      <h3>
        <span class={lane.backlog ? undefined : 'mono'}>{lane.version}</span>
        {lane.title && <span class="rm-lane-title">{lane.title}</span>}
      </h3>
      {lane.status && <Chip tone={statusTone(lane.status)}>{lane.status}</Chip>}
      {lane.target && <span class="muted">{lane.target}</span>}
      {lane.backlog ? (
        <span class="progress-text rm-lane-count">{total === 1 ? '1 card' : `${total} cards`}</span>
      ) : (
        total > 0 && (
          <span class="rm-lane-progress">
            <span class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-label={`${lane.version} progress`}>
              <span class="progress-fill" style={{ width: `${Math.round((done / total) * 100)}%` }} />
            </span>
            <span class="progress-text">
              {done} of {total}
            </span>
          </span>
        )
      )}
    </header>
  );
}

function ReleaseForm({ suggested, onAdd, onClose }: { suggested: string; onAdd(version: string, title: string): void; onClose(): void }): JSX.Element {
  const version = useRef<HTMLInputElement>(null);
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => version.current?.select(), []);
  return (
    <form
      class="rm-release-form"
      onSubmit={(e) => {
        e.preventDefault();
        const v = version.current?.value.trim() ?? '';
        if (!v) return;
        onAdd(v, title.current?.value.trim() ?? '');
        onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <input ref={version} class="rm-input rm-version-input mono" type="text" defaultValue={suggested} aria-label="Version" placeholder="1.2.0" maxLength={30} />
      <input ref={title} class="rm-input" type="text" aria-label="Title" placeholder="Title (optional)" maxLength={120} />
      <button type="submit" class="btn btn-primary btn-small">
        Add release
      </button>
      <button type="button" class="btn btn-small" onClick={onClose}>
        Cancel
      </button>
    </form>
  );
}

/** The release after the highest one planned, or after the current version. */
function suggestVersion(lanes: ReleasePlan[], current?: string): string {
  const key = (v: string): number[] => v.split(/[.-]/).map((n) => Number(n) || 0);
  const versions = lanes.filter((l) => !l.backlog).map((l) => l.version);
  if (current) versions.push(current);
  const highest = versions.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  });
  return nextMinor(highest.at(-1));
}

export function Roadmap(): JSX.Element {
  const { state, post } = useCockpit();
  const r = state.releases;
  const [drag, setDrag] = useState<string | undefined>();
  const [over, setOver] = useState<Drop | undefined>();
  const [adding, setAdding] = useState<string | undefined>();
  const [addingRelease, setAddingRelease] = useState(false);

  const edit = (e: RoadmapEdit): void => post({ type: 'roadmap', edit: e });

  if (!r.roadmapExists) {
    return (
      <Section id="roadmap" title="Roadmap">
        <div class="rm-none">
          <p class="empty">No ROADMAP.md yet. The board keeps its cards there: a plain file that you, and any Claude, can also edit by hand.</p>
          <button type="button" class="btn btn-primary" onClick={() => edit({ op: 'create' })}>
            Create roadmap
          </button>
        </div>
      </Section>
    );
  }

  // The backlog is always on the board; the file gets its section when the first card lands there.
  const lanes: ReleasePlan[] = r.roadmap.some((l) => l.backlog) ? r.roadmap : [...r.roadmap, { version: 'Backlog', backlog: true, items: [] }];
  const dragged = drag === undefined ? undefined : lanes.flatMap((l) => l.items.map((item) => ({ item, lane: l }))).find((x) => x.item.id === drag);

  // dragover fires many times a second: keep the same object while the target is the same.
  const hover = (d: Drop): void => setOver((prev) => (prev && prev.lane === d.lane && prev.status === d.status && prev.before === d.before ? prev : d));

  const endDrag = (): void => {
    setDrag(undefined);
    setOver(undefined);
  };

  // The target comes from the drop event itself, not from `over`: a drop can follow its first dragover before
  // the board has redrawn.
  const drop = (target: Drop): void => {
    const from = dragged;
    endDrag();
    if (!from) return;
    const sameLane = target.lane === from.lane.version;
    const onItself = target.before === from.item.id;
    if (sameLane && (onItself || target.before === undefined)) {
      // Dropped in its own lane without a place among other cards: only the column can have changed.
      if (target.status !== from.item.status) edit({ op: 'setStatus', id: from.item.id, status: target.status });
      return;
    }
    edit({ op: 'move', id: from.item.id, lane: target.lane, status: target.status, ...(target.before && !onItself ? { before: target.before } : {}) });
  };

  const cards = r.roadmap.reduce((n, l) => n + l.items.length, 0);

  return (
    <Section
      id="roadmap"
      title="Roadmap"
      meta={<>{cards === 1 ? '1 card' : `${cards} cards`} · ROADMAP.md</>}
      actions={
        <>
          <button type="button" class="btn btn-small" onClick={() => setAddingRelease(true)}>
            <Icon name="plus" /> Release
          </button>
          <button type="button" class="btn btn-small" onClick={() => post({ type: 'openRoadmap' })}>
            <Icon name="file" /> Open file
          </button>
        </>
      }
    >
      {addingRelease && (
        <ReleaseForm
          suggested={suggestVersion(r.roadmap, r.currentVersion)}
          onAdd={(version, title) => edit({ op: 'addRelease', version, ...(title ? { title } : {}) })}
          onClose={() => setAddingRelease(false)}
        />
      )}
      <div class="rm" onDragEnd={endDrag}>
        {lanes.map((lane) => (
          <section key={lane.version} class={lane.backlog ? 'rm-lane rm-backlog' : 'rm-lane'} aria-label={laneLabel(lane)}>
            <LaneHead lane={lane} />
            <div class="rm-cells">
              {COLUMNS.map((col) => {
                const items = lane.items.filter((i) => i.status === col.status);
                const isOver = drag !== undefined && over?.lane === lane.version && over.status === col.status;
                return (
                  <div
                    key={col.status}
                    class={isOver ? 'rm-cell rm-over' : 'rm-cell'}
                    onDragOver={(e) => {
                      if (drag === undefined) return;
                      e.preventDefault();
                      hover({ lane: lane.version, status: col.status });
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      drop({ lane: lane.version, status: col.status });
                    }}
                  >
                    <h4 class="rm-cell-head">
                      {col.label}
                      {items.length > 0 && <span class="count">{items.length}</span>}
                    </h4>
                    <ul class="rm-cards" aria-label={`${laneLabel(lane)}: ${col.label}`}>
                      {items.map((item) => (
                        <Card
                          key={item.id}
                          item={item}
                          lane={lane}
                          lanes={lanes}
                          dragging={drag === item.id}
                          dropBefore={isOver && over?.before === item.id && drag !== item.id}
                          edit={edit}
                          onDragStart={setDrag}
                          onDragEnd={endDrag}
                          onDragOver={hover}
                          onDrop={drop}
                        />
                      ))}
                    </ul>
                    {col.status === 'todo' &&
                      (adding === lane.version ? (
                        <LineInput label={`New card in ${laneLabel(lane)}`} placeholder="What needs doing?" keepOpen onCommit={(text) => edit({ op: 'add', lane: lane.version, text })} onClose={() => setAdding(undefined)} />
                      ) : (
                        <button type="button" class="rm-add" onClick={() => setAdding(lane.version)}>
                          <Icon name="plus" /> Add card
                        </button>
                      ))}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </Section>
  );
}
