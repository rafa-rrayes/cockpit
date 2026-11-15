// The settings popover under the top bar's sliders button: Cockpit's VS Code settings (cockpit.*) on one small
// panel, in two tabs: All projects (the user's settings) and This project (the workspace's). Every change is posted
// to the host, which writes it where its tab says; the popover redraws from the State that comes back, so it always
// shows what VS Code holds.
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { EFFORTS, MAX_SUBAGENTS, MODELS, STANDARD_STEPS } from '../../src/launch';
import type { SectionId } from '../../src/model';
import { isRepoFile, MAX_ENDED_DAYS, MAX_PROMPT_STEP_CHARS, MAX_PROMPT_STEPS, MAX_VERSION_FILES, MIN_GITHUB_SECONDS, SECTIONS, type SettingKey } from '../../src/settings';
import { useCockpit } from '../context';

/** A whole number, written when the field is left or Enter is pressed; anything out of range snaps back. */
function NumberField(props: { label: string; unit: string; value: number; min: number; max?: number; onCommit(v: number): void }): JSX.Element {
  const [draft, setDraft] = useState(String(props.value));
  useEffect(() => setDraft(String(props.value)), [props.value]);
  // A refused value is written back to the field itself too: when the draft returns to the value it last rendered,
  // Preact sees no change and would leave the refused text showing.
  const commit = (el: HTMLInputElement): void => {
    const v = Number(el.value);
    if (el.value.trim() !== '' && Number.isInteger(v) && v >= props.min && (props.max === undefined || v <= props.max)) {
      if (v !== props.value) props.onCommit(v);
      return;
    }
    el.value = String(props.value);
    setDraft(el.value);
  };
  return (
    <label class="set-row">
      <span class="set-label">{props.label}</span>
      <input
        class="rm-input set-number"
        type="number"
        min={props.min}
        max={props.max}
        step={1}
        value={draft}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onChange={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => e.key === 'Enter' && commit(e.currentTarget)}
      />
      <span class="set-unit">{props.unit}</span>
    </label>
  );
}

function Check(props: { label: string; checked: boolean; onChange(v: boolean): void; title?: string }): JSX.Element {
  return (
    <label class="check set-check" title={props.title}>
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      {props.label}
    </label>
  );
}

const sameList = (a: string[], b: string[]): boolean => a.length === b.length && a.every((s, i) => s === b[i]);

/** The prompt's steps, one per line, written when the field is left. Clearing it, or writing the standard steps
 *  back, returns to the standard. */
function PromptSteps({ steps, onCommit }: { steps: string[]; onCommit(steps: string[]): void }): JSX.Element {
  const shown = steps.length ? steps : STANDARD_STEPS;
  const text = shown.join('\n');
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = (): void => {
    const lines = draft
      .split('\n')
      .map((l) => l.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT_STEP_CHARS))
      .filter(Boolean)
      .slice(0, MAX_PROMPT_STEPS);
    const next = sameList(lines, STANDARD_STEPS) ? [] : lines;
    if (sameList(next, steps)) setDraft(text);
    else onCommit(next);
  };
  return (
    <>
      <textarea class="rm-input set-prompt" rows={7} aria-label="Prompt steps, one per line" value={draft} onInput={(e) => setDraft(e.currentTarget.value)} onBlur={commit} />
      <p class="set-note">
        One step per line. Where it works, committing and subagents come from the launcher's options.
        {steps.length > 0 && (
          <>
            {' '}
            <button type="button" class="link" onClick={() => onCommit([])}>
              Reset to standard
            </button>
          </>
        )}
      </p>
    </>
  );
}

/** The files Release bumps besides package.json, one path per line, written when the field is left. Lines that are
 *  not a path inside the repository are dropped. */
function VersionFiles({ files, onCommit }: { files: string[]; onCommit(files: string[]): void }): JSX.Element {
  const text = files.join('\n');
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const commit = (): void => {
    const next = [
      ...new Set(
        draft
          .split('\n')
          .map((l) => l.trim())
          .filter(isRepoFile),
      ),
    ].slice(0, MAX_VERSION_FILES);
    if (sameList(next, files)) setDraft(text);
    else onCommit(next);
  };
  return (
    <>
      <textarea
        class="rm-input set-prompt"
        rows={3}
        aria-label="Version files, one path per line"
        placeholder="pyproject.toml"
        value={draft}
        onInput={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
      />
      <p class="set-note">package.json always, when it has a version. One path per line, from the repository root.</p>
    </>
  );
}

export function SettingsPopover(): JSX.Element {
  const { state, post, update } = useCockpit();
  const s = state.settings;
  const set = (key: SettingKey, value: unknown): void => post({ type: 'setSetting', edit: { key, value } });
  // A new default for the launcher applies at once, over the options the last Claude was started with.
  const setLaunch = (key: SettingKey, value: unknown): void => {
    set(key, value);
    update({ launch: undefined });
  };
  const hidden = new Set(s.hiddenSections);
  const toggleSection = (id: SectionId, show: boolean): void => {
    const next = new Set(hidden);
    if (show) next.delete(id);
    else next.add(id);
    set(
      'hiddenSections',
      SECTIONS.map((x) => x.id).filter((x) => next.has(x)),
    );
  };
  const project = state.workspace?.name;
  const [tab, setTab] = useState<'all' | 'project'>('all');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);

  return (
    <div class="set-pop" role="dialog" aria-label="Cockpit settings">
      {project && (
        <div class="segmented set-tabs" role="group" aria-label="Settings for">
          <button type="button" aria-pressed={tab === 'all'} onClick={() => setTab('all')}>
            All projects
          </button>
          <button type="button" aria-pressed={tab === 'project'} onClick={() => setTab('project')} title={state.workspace?.path}>
            This project: <span class="set-project">{project}</span>
          </button>
        </div>
      )}
      {tab === 'project' && project ? (
        <>
          <p class="set-note">Saved in this project's .vscode/settings.json. Other projects keep their own.</p>
          <fieldset class="set-group">
            <legend>Prompt</legend>
            <PromptSteps steps={s.promptSteps} onCommit={(steps) => set('promptSteps', steps)} />
          </fieldset>

          <fieldset class="set-group">
            <legend>Release bumps the version in</legend>
            <VersionFiles files={s.releaseVersionFiles} onCommit={(files) => set('release.versionFiles', files)} />
          </fieldset>
        </>
      ) : (
        <>
          <fieldset class="set-group">
            <legend>General</legend>
            <label class="check set-check">
              <input ref={first} type="checkbox" checked={s.openOnStartup} onChange={(e) => set('openOnStartup', e.currentTarget.checked)} />
              Open Cockpit when a window starts
            </label>
            <NumberField label="Ended sessions" unit="days" value={s.endedSessionDays} min={0} max={MAX_ENDED_DAYS} onCommit={(v) => set('endedSessionDays', v)} />
            <NumberField label="Ask GitHub every" unit="seconds" value={s.githubPollSeconds} min={MIN_GITHUB_SECONDS} onCommit={(v) => set('githubPollSeconds', v)} />
          </fieldset>

          <fieldset class="set-group">
            <legend>Sections</legend>
            <div class="set-sections">
              {SECTIONS.map((x) => (
                <Check key={x.id} label={x.label} checked={!hidden.has(x.id)} onChange={(show) => toggleSection(x.id, show)} />
              ))}
            </div>
          </fieldset>

          <fieldset class="set-group">
            <legend>Start Claude opens with</legend>
            <div class="set-row">
              <span class="set-label">Model</span>
              <div class="segmented" role="group" aria-label="Model">
                {MODELS.map((m) => (
                  <button key={m.label} type="button" aria-pressed={s.launch.model === m.model} onClick={() => setLaunch('launch.model', m.model ?? 'default')}>
                    {m.label}
                  </button>
                ))}
              </div>
            </div>
            <div class="set-row">
              <span class="set-label">Thinking</span>
              <div class="segmented" role="group" aria-label="Thinking">
                {EFFORTS.map((e) => (
                  <button key={e} type="button" aria-pressed={s.launch.effort === e} onClick={() => setLaunch('launch.effort', e)}>
                    {e}
                  </button>
                ))}
              </div>
            </div>
            <NumberField
              label="Subagents"
              unit={s.launch.subagents === 0 ? 'works alone' : 'in parallel'}
              value={s.launch.subagents}
              min={0}
              max={MAX_SUBAGENTS}
              onCommit={(v) => setLaunch('launch.subagents', v)}
            />
            {s.launch.subagents > 0 && (
              <div class="set-row">
                <span class="set-label">Subagent model</span>
                <div class="segmented" role="group" aria-label="Subagent model">
                  {MODELS.map((m) => (
                    <button key={m.label} type="button" aria-pressed={s.launch.subagentModel === m.model} onClick={() => setLaunch('launch.subagentModel', m.model ?? 'auto')}>
                      {m.model ? m.label : 'Auto'}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div class="set-sections">
              <Check label="Own worktree" checked={s.launch.worktree} onChange={(v) => setLaunch('launch.worktree', v)} />
              <Check label="Mark in progress" checked={s.launch.markDoing} onChange={(v) => setLaunch('launch.markDoing', v)} />
            </div>
          </fieldset>
        </>
      )}

      <div class="set-foot">
        <button type="button" class="link" onClick={() => post({ type: 'openSettings' })}>
          All settings…
        </button>
      </div>
    </div>
  );
}
