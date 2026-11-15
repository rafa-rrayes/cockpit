// The roadmap as a board: a lane per release (and the backlog), a column per status. Every change is posted to
// the host, which edits ROADMAP.md; the board redraws from the State that comes back. Open cards can be selected
// (Cmd/Ctrl-click) and handed to a new Claude from their right-click menu.
import type { JSX, RefObject } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ItemStatus, LaunchOptions, ReleasePlan, RoadmapEdit, RoadmapItem } from '../../src/model';
import { nextMinor } from '../../src/data/roadmap';
import { releaseStep, tagName } from '../../src/publish';
import { EFFORTS, MAX_SUBAGENTS, MODELS } from '../../src/launch';
import { useCockpit } from '../context';
import { Icon, type IconName } from '../icons';
import { Chip, Section, useDismiss } from '../ui';

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

interface Point {
  x: number;
  y: number;
}

/** Keeps a fixed-position popup that opens at `at` inside the window: moved left or up when it would overflow,
 *  again whenever it grows (the launcher pulls rows out). */
function useFitInView(ref: RefObject<HTMLElement | null>, at: Point | undefined): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !at) return;
    const fit = (): void => {
      const margin = 8;
      const { width, height } = el.getBoundingClientRect();
      el.style.left = `${Math.max(margin, Math.min(at.x, window.innerWidth - width - margin))}px`;
      el.style.top = `${Math.max(margin, Math.min(at.y, window.innerHeight - height - margin))}px`;
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    return () => observer.disconnect();
  }, [at?.x, at?.y]);
}

interface CardProps {
  item: RoadmapItem;
  lane: ReleasePlan;
  lanes: ReleasePlan[];
  dragging: boolean;
  dropBefore: boolean;
  selected: boolean;
  /** How many cards are selected in all. */
  selectedCount: number;
  edit(e: RoadmapEdit): void;
  /** toggle: Cmd/Ctrl-click. only: a right-click on a card outside the selection. clear: a plain click. */
  onSelect(id: string, how: 'toggle' | 'only' | 'clear'): void;
  /** Open the launcher at `at` for the selection, or for this card alone when it is not part of one. */
  onStart(at: Point): void;
  onDragStart(id: string): void;
  onDragEnd(): void;
  onDragOver(drop: Drop): void;
  onDrop(drop: Drop): void;
}

function Card({ item, lane, lanes, dragging, dropBefore, selected, selectedCount, edit, onSelect, onStart, onDragStart, onDragEnd, onDragOver, onDrop }: CardProps): JSX.Element {
  const [renaming, setRenaming] = useState(false);
  /** Open: from the ⋯ button (no point) or a right-click (at the pointer). */
  const [menu, setMenu] = useState<{ at?: Point } | undefined>();
  const root = useRef<HTMLLIElement>(null);
  const menuEl = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);

  // The menu closes on a click anywhere else and on Escape, which hands focus back to its button.
  useDismiss(root, menu !== undefined, (byKey) => {
    setMenu(undefined);
    if (byKey) menuButton.current?.focus();
  });
  useFitInView(menuEl, menu?.at);

  const pick = (e: RoadmapEdit): void => {
    setMenu(undefined);
    edit(e);
  };

  const open = item.status !== 'done';
  // The menu speaks for the whole selection when this card is part of one bigger than itself.
  const many = selected && selectedCount > 1;
  const start = (): void => {
    const at = menu?.at ?? (() => {
      const r = root.current?.getBoundingClientRect();
      return { x: r?.left ?? 0, y: r?.bottom ?? 0 };
    })();
    setMenu(undefined);
    onStart(at);
  };

  const cls = ['rm-card', `rm-${item.status}`, dragging && 'rm-dragging', dropBefore && 'rm-drop-before', selected && 'rm-selected'].filter(Boolean).join(' ');
  return (
    <li
      ref={root}
      class={cls}
      draggable={!renaming}
      aria-selected={open ? selected : undefined}
      onClick={(e) => {
        if (renaming || menu || (e.target instanceof Element && e.target.closest('button, input, .rm-menu'))) return;
        if (e.metaKey || e.ctrlKey) {
          if (open) onSelect(item.id, 'toggle');
        } else onSelect(item.id, 'clear');
      }}
      onContextMenu={(e) => {
        if (renaming) return;
        e.preventDefault();
        if (open && !selected) onSelect(item.id, 'only');
        setMenu({ at: { x: e.clientX, y: e.clientY } });
      }}
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
        <span class="rm-text" onDblClick={() => setRenaming(true)} title={open ? 'Double-click to rename. Cmd/Ctrl-click to select, right-click to start a Claude on it.' : 'Double-click to rename'}>
          {item.text}
        </span>
      )}
      {!renaming && item.branch && <CardBranch branch={item.branch} />}
      {!renaming && (
        <button ref={menuButton} type="button" class="btn-icon rm-menu-button" aria-haspopup="menu" aria-expanded={menu !== undefined} aria-label={`Actions for ${item.text}`} onClick={() => setMenu((m) => (m ? undefined : {}))}>
          <Icon name="more" />
        </button>
      )}
      {menu && (
        <div ref={menuEl} class={menu.at ? 'rm-menu rm-menu-at' : 'rm-menu'} role="menu">
          {open && (
            <>
              <button type="button" role="menuitem" class="rm-menu-start" onClick={start}>
                <Icon name="sparkle" /> {many ? `Start Claude on ${selectedCount} cards…` : 'Start Claude…'}
              </button>
              <hr />
            </>
          )}
          {many ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(undefined);
                onSelect(item.id, 'clear');
              }}
            >
              Clear selection
            </button>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenu(undefined);
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
            </>
          )}
        </div>
      )}
    </li>
  );
}

/** The branch working on a card, and its pull request once there is one. */
function CardBranch({ branch }: { branch: string }): JSX.Element {
  const { state, post } = useCockpit();
  const pr = state.work.items.find((i) => i.branch === branch)?.pr;
  return (
    <span class="rm-branch">
      <span class="mono rm-branch-name" title={`Branch ${branch}`}>
        <Icon name="branch" />
        {branch.replace(/^worktree-/, '')}
      </span>
      {pr && (
        <button type="button" class="link rm-branch-pr" title={`Open #${pr.number} on GitHub`} onClick={() => post({ type: 'openUrl', url: pr.url })}>
          #{pr.number} {pr.state === 'open' ? 'in review' : pr.state}
        </button>
      )}
    </span>
  );
}

/** The lane's next release step, when it has one: Release…, its open pull request, or Tag. */
function ReleaseButton({ lane }: { lane: ReleasePlan }): JSX.Element | null {
  const { state, post } = useCockpit();
  const step = releaseStep(lane, state);
  if (!step) return null;
  if (step.step === 'review') {
    const { pr } = step;
    return (
      <button type="button" class="link rm-release-step" title={`Open #${pr.number} on GitHub`} onClick={() => post({ type: 'openUrl', url: pr.url })}>
        <Icon name="pr" /> Release #{pr.number} in review
      </button>
    );
  }
  if (step.step === 'tag') {
    return (
      <button type="button" class="btn btn-small btn-primary rm-release-step" title="Tags the merged release and pushes the tag, after a confirmation" onClick={() => post({ type: 'tag', version: lane.version })}>
        <Icon name="tag" /> Tag {tagName(lane.version)}…
      </button>
    );
  }
  return (
    <button type="button" class="btn btn-small btn-primary rm-release-step" title="Prepares the release pull request (version, changelog, roadmap), after showing it" onClick={() => post({ type: 'release', version: lane.version })}>
      <Icon name="tag" /> Release {lane.version}…
    </button>
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
      <ReleaseButton lane={lane} />
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

interface LauncherProps {
  cards: RoadmapItem[];
  at: Point;
  initial: LaunchOptions;
  /** Off outside git: the Claude cannot have a worktree then. */
  canWorktree: boolean;
  onStart(options: LaunchOptions): void;
  onClose(): void;
}

/** How far down a drag from the thinking slider (or its handle) has to go to pull out the subagents slider. */
const PULL_PX = 14;

/** A slider of a few steps, its track filled up to the value, with the value written after it. */
function Steps(props: { label: string; icon: IconName; value: number; max: number; text: string; onChange(v: number): void; onPointerDown?(e: PointerEvent): void }): JSX.Element {
  return (
    <div class="rm-steps">
      <Icon name={props.icon} />
      <input
        type="range"
        min={0}
        max={props.max}
        step={1}
        value={props.value}
        aria-label={props.label}
        aria-valuetext={props.text}
        style={{ '--fill': `${(props.value / props.max) * 100}%` }}
        onInput={(e) => props.onChange(Number(e.currentTarget.value))}
        onPointerDown={props.onPointerDown}
      />
      <span class="rm-steps-value">{props.text}</span>
    </div>
  );
}

/** The small chevron under a slider: click it, or drag down from it, for the next row; click it again to fold
 *  that row away. */
function PullHandle(props: { open: boolean; what: string; from: string; onPointerDown(e: PointerEvent): void; onToggle(): void }): JSX.Element {
  return (
    <button
      type="button"
      class="rm-pull"
      aria-expanded={props.open}
      aria-label={props.open ? `Hide ${props.what.toLowerCase()}` : props.what}
      title={props.open ? `Hide ${props.what.toLowerCase()}` : `${props.what} (or drag the ${props.from} down)`}
      onPointerDown={props.onPointerDown}
      onClick={props.onToggle}
    >
      <Icon name="chevron" class={props.open ? 'rm-pull-up' : undefined} />
    </button>
  );
}

/** Where a Claude is started from: the model and the thinking slider; pulled down from it, the subagents slider;
 *  pulled down once more, the model the subagents run on. */
function Launcher({ cards, at, initial, canWorktree, onStart, onClose }: LauncherProps): JSX.Element {
  const [o, setO] = useState<LaunchOptions>(() => ({ ...initial, worktree: initial.worktree && canWorktree }));
  // How far the launcher is pulled out: 0 thinking only, 1 the subagents slider, 2 the subagent model too.
  const [depth, setDepth] = useState(initial.subagentModel ? 2 : initial.subagents > 0 ? 1 : 0);
  const root = useRef<HTMLDivElement>(null);
  const go = useRef<HTMLButtonElement>(null);
  useDismiss(root, true, onClose);
  useFitInView(root, at);
  useEffect(() => go.current?.focus(), []);

  const set = (patch: Partial<LaunchOptions>): void => setO((prev) => ({ ...prev, ...patch }));
  /** Pulled out to `d`, or pushed back to it: what is hidden again is reset, so it is never sent unseen. */
  const showTo = (d: number): void => {
    setDepth(d);
    if (d < 2) set({ subagentModel: undefined });
    if (d < 1) set({ subagents: 0 });
  };

  // A drag that goes down from a slider or the handle under it pulls out the next row.
  const pull = (to: number) => (e: PointerEvent): void => {
    const from = e.clientY;
    const move = (m: PointerEvent): void => {
      if (m.clientY - from < PULL_PX) return;
      setDepth((d) => Math.max(d, to));
      stop();
    };
    const stop = (): void => {
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', stop);
    };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', stop);
  };

  const planned = cards.some((c) => c.status === 'todo');
  const first = cards[0]?.text ?? '';

  return (
    <div ref={root} class="rm-launch" role="dialog" aria-label={cards.length === 1 ? `Start Claude on ${first}` : `Start Claude on ${cards.length} cards`}>
      <form
        class="rm-launch-form"
        onSubmit={(e) => {
          e.preventDefault();
          onStart(o);
        }}
      >
        <div class="rm-launch-head" title={cards.map((c) => c.text).join('\n')}>
          <span class="rm-launch-first">{first}</span>
          {cards.length > 1 && <span class="count">+{cards.length - 1}</span>}
        </div>

        <div class="segmented" role="group" aria-label="Model">
          {MODELS.map((m) => (
            <button key={m.label} type="button" aria-pressed={o.model === m.model} onClick={() => set({ model: m.model })}>
              {m.label}
            </button>
          ))}
        </div>

        <Steps label="Thinking" icon="bulb" value={EFFORTS.indexOf(o.effort)} max={EFFORTS.length - 1} text={o.effort} onChange={(v) => set({ effort: EFFORTS[v] ?? o.effort })} onPointerDown={pull(1)} />
        <PullHandle open={depth >= 1} what="Subagents" from="thinking slider" onPointerDown={pull(1)} onToggle={() => showTo(depth >= 1 ? 0 : 1)} />
        {depth >= 1 && (
          <div class="rm-pulled">
            <Steps label="Subagents" icon="agent" value={o.subagents} max={MAX_SUBAGENTS} text={o.subagents === 0 ? 'none' : String(o.subagents)} onChange={(v) => set({ subagents: v })} onPointerDown={pull(2)} />
          </div>
        )}
        {depth >= 1 && <PullHandle open={depth >= 2} what="Subagent model" from="subagents slider" onPointerDown={pull(2)} onToggle={() => showTo(depth >= 2 ? 1 : 2)} />}
        {depth >= 2 && (
          <div class="rm-pulled rm-sub-model">
            <Icon name="agent" />
            <div class="segmented" role="group" aria-label="Subagent model">
              {MODELS.map((m) => (
                <button key={m.label} type="button" aria-pressed={o.subagentModel === m.model} title={m.model ? `Every subagent runs on ${m.label}` : 'Claude Code picks'} onClick={() => set({ subagentModel: m.model })}>
                  {m.model ? m.label : 'Auto'}
                </button>
              ))}
            </div>
          </div>
        )}

        <div class="rm-launch-foot">
          <button
            type="button"
            class="btn-icon rm-toggle"
            aria-pressed={o.worktree}
            disabled={!canWorktree}
            title={canWorktree ? 'Own worktree' : 'Own worktree (not a git repository)'}
            aria-label="Own worktree"
            onClick={() => set({ worktree: !o.worktree })}
          >
            <Icon name="branch" />
          </button>
          <button
            type="button"
            class="btn-icon rm-toggle"
            aria-pressed={o.markDoing && planned}
            disabled={!planned}
            title="Mark in progress"
            aria-label="Mark in progress"
            onClick={() => set({ markDoing: !o.markDoing })}
          >
            <Icon name="play" />
          </button>
          <button ref={go} type="submit" class="btn btn-primary btn-small rm-go">
            <Icon name="sparkle" /> Start
          </button>
        </div>
      </form>
    </div>
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
  const { state, ui, update, post } = useCockpit();
  const r = state.releases;
  const [drag, setDrag] = useState<string | undefined>();
  const [over, setOver] = useState<Drop | undefined>();
  const [adding, setAdding] = useState<string | undefined>();
  const [addingRelease, setAddingRelease] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [launch, setLaunch] = useState<{ ids: string[]; at: Point } | undefined>();

  const edit = (e: RoadmapEdit): void => post({ type: 'roadmap', edit: e });

  // Ids name a line of the file: after an edit they can stop naming a card, so the selection keeps only the open
  // cards that are still there.
  const open = new Map(r.roadmap.flatMap((l) => l.items.filter((i) => i.status !== 'done').map((i) => [i.id, i] as const)));
  const selected = picked.filter((id) => open.has(id));

  // Escape clears the selection (popups take their Escape first).
  useEffect(() => {
    if (selected.length === 0) return;
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setPicked([]);
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [selected.length > 0]);

  const select = (id: string, how: 'toggle' | 'only' | 'clear'): void => {
    if (how === 'clear') setPicked([]);
    else if (how === 'only') setPicked([id]);
    else setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev.filter((x) => open.has(x)), id]));
  };

  /** The launcher, for the selection when `id` is part of it, else for that card alone. */
  const startFor = (id: string, at: Point): void => setLaunch({ ids: selected.includes(id) ? selected : [id], at });

  const launchCards = (launch?.ids ?? []).map((id) => open.get(id)).filter((i) => i !== undefined);

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
          {selected.length > 0 && (
            <span class="rm-selection">
              <span class="muted">{selected.length} selected</span>
              <button
                type="button"
                class="btn btn-primary btn-small"
                onClick={(e) => {
                  const b = e.currentTarget.getBoundingClientRect();
                  setLaunch({ ids: selected, at: { x: b.left, y: b.bottom + 4 } });
                }}
              >
                <Icon name="sparkle" /> Start Claude…
              </button>
              <button type="button" class="btn btn-small" onClick={() => setPicked([])}>
                Clear
              </button>
            </span>
          )}
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
                          selected={selected.includes(item.id)}
                          selectedCount={selected.length}
                          edit={edit}
                          onSelect={select}
                          onStart={(at) => startFor(item.id, at)}
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
      {launch && launchCards.length > 0 && (
        <Launcher
          cards={launchCards}
          at={launch.at}
          initial={ui.launch ?? state.settings.launch}
          canWorktree={state.work.available}
          onClose={() => setLaunch(undefined)}
          onStart={(options) => {
            post({ type: 'startClaude', ids: launchCards.map((c) => c.id), options });
            update({ launch: options });
            setLaunch(undefined);
            setPicked([]);
          }}
        />
      )}
    </Section>
  );
}
