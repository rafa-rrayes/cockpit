// Starting a Claude on roadmap cards: the options the board offers, and the command line they become. Kept free of
// `vscode` and node modules: the webview imports the options, and the prompt and arguments are unit-tested.
import type { ClaudeModel, Effort, LaunchOptions } from './model';

export const MODELS: { model?: ClaudeModel; label: string }[] = [
  { label: 'Default' },
  { model: 'fable', label: 'Fable' },
  { model: 'opus', label: 'Opus' },
  { model: 'sonnet', label: 'Sonnet' },
  { model: 'haiku', label: 'Haiku' },
];

export const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MAX_SUBAGENTS = 8;
/** A batch bigger than this is better split: one Claude cannot hold that much at once. */
export const MAX_BATCH = 20;

export const defaultLaunch: LaunchOptions = { effort: 'high', subagents: 0, worktree: true, markDoing: true };

// ───────────────────────────── Checking options ─────────────────────────────

const isModel = (v: unknown): v is ClaudeModel => MODELS.some((m) => m.model !== undefined && m.model === v);
const isEffort = (v: unknown): v is Effort => EFFORTS.includes(v as Effort);

/** The options with every field of the right kind, or undefined. */
export function parseLaunchOptions(raw: unknown): LaunchOptions | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r.model !== undefined && !isModel(r.model)) return undefined;
  if (!isEffort(r.effort)) return undefined;
  if (typeof r.subagents !== 'number' || !Number.isInteger(r.subagents) || r.subagents < 0 || r.subagents > MAX_SUBAGENTS) return undefined;
  if (r.subagentModel !== undefined && !isModel(r.subagentModel)) return undefined;
  const options: LaunchOptions = { effort: r.effort, subagents: r.subagents, worktree: r.worktree === true, markDoing: r.markDoing === true };
  if (r.model !== undefined) options.model = r.model;
  // Without subagents there is nothing to run on another model.
  if (r.subagentModel !== undefined && r.subagents > 0) options.subagentModel = r.subagentModel;
  return options;
}

// ───────────────────────────── The command line ─────────────────────────────

export interface LaunchCard {
  text: string;
  /** The lane's name: "1.2.0" or "Backlog". */
  lane: string;
}

/** A worktree name from the first card: its lane ("1.2.0", "backlog"), then the card's first words, lowercase and
 *  joined by dashes, short enough for a branch. Claude Code names the branch "worktree-<name>". */
export function worktreeName(cards: LaunchCard[]): string {
  const first = cards[0];
  const words = (first?.text ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let name = '';
  for (const w of words) {
    const next = name ? `${name}-${w}` : w;
    if (next.length > 32) break;
    name = next;
  }
  name ||= (words[0] ?? '').slice(0, 32) || 'roadmap';
  // Dots stay, for versions; nothing that git refuses in a branch name ("..", a leading or trailing dot).
  const lane = (first?.lane ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .slice(0, 24)
    .replace(/^[-.]+|[-.]+$/g, '');
  return lane ? `${lane}-${name}` : name;
}

/** What the session and its terminal are called: the first card, and how many more. */
export function sessionName(cards: LaunchCard[]): string {
  const first = (cards[0]?.text ?? 'Roadmap').replace(/\s+/g, ' ').trim();
  const short = first.length > 48 ? `${first.slice(0, 47)}…` : first;
  return cards.length > 1 ? `${short} (+${cards.length - 1})` : short;
}

/** The general steps of the standard prompt; cockpit.promptSteps replaces them. The steps that depend on the
 *  launcher's options (worktree or main checkout, committing, subagents, batches) are added around them. */
export const STANDARD_STEPS: string[] = [
  'Read CLAUDE.md (and the rules it points to), README.md and tasks/lessons.md where they exist, and follow them: they come before anything below.',
  'Read the code involved before deciding anything. Make the change as small as the card needs: no unrelated refactors and no features nobody asked for. If a card is ambiguous, take the most likely reading and say which.',
  "Prove it works with the project's own scripts: typecheck, build, and run the tests, adding tests for new behaviour. It is not done until they pass.",
  'Where the project keeps a CHANGELOG.md (Unreleased) or a README.md, update them for any change a user would notice.',
  'Leave ROADMAP.md alone: Cockpit moves these cards on the board.',
];

/** The standard every Claude started from the board works by: the general steps (`general`, or the standard ones
 *  when it is empty), with where it works after the first of them, and committing and subagents after the rest. */
export function launchPrompt(cards: LaunchCard[], options: LaunchOptions, project: string, general: string[] = []): string {
  const batch = cards.length > 1;
  const list = cards.map((c) => `- ${c.text.replace(/\s+/g, ' ').trim()} (${c.lane})`).join('\n');
  const [first, ...rest] = (general.length ? general : STANDARD_STEPS).map((s) => s.replace(/\s+/g, ' ').trim());
  const steps = [
    ...(first ? [first] : []),
    options.worktree
      ? 'You are in a new git worktree, on a branch of its own. Keep every change there and leave the main checkout alone.'
      : 'You are in the main checkout. Run `git status` first: leave changes you did not make alone, and ask before touching those files.',
    ...rest,
    options.worktree
      ? 'Commit on this branch with clear messages. Do not push, open a pull request or merge unless I ask.'
      : 'Do not commit, push or open a pull request: leave the changes for me to review.',
    options.subagents === 0
      ? 'Do the work yourself: do not start subagents.'
      : `Use up to ${options.subagents} subagent${options.subagents === 1 ? '' : 's'} in parallel for parts that are really independent (research, separate cards, an independent review). Give each a narrow, self-contained brief, keep work you can hold in your head inline, and check what they return before you rely on it.${options.subagentModel ? ` Every subagent runs on ${modelLabel(options.subagentModel)}: size their work to it.` : ''}`,
  ];
  if (batch) steps.push(`The ${cards.length} cards are one batch: do them together${options.worktree ? ', on this one branch, with a commit per card where they separate cleanly' : ''}.`);
  return [
    `Work on ${batch ? `these ${cards.length} cards` : 'this card'} from the roadmap of ${project} (ROADMAP.md):`,
    '',
    list,
    '',
    'How to work:',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    'Finish with a short report: what changed, how you verified it, and anything left open.',
  ].join('\n');
}

const modelLabel = (m: ClaudeModel): string => MODELS.find((x) => x.model === m)?.label ?? m;

/** The environment for `claude` on top of the terminal's: the subagent model, forced, so that the model a Claude
 *  names for an agent is ignored. */
export function launchEnv(options: LaunchOptions): Record<string, string> {
  if (!options.subagentModel || options.subagents === 0) return {};
  return { CLAUDE_CODE_SUBAGENT_MODEL: options.subagentModel, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' };
}

/** The arguments to `claude`, as an argv array: no shell sees them. */
export function launchArgs(cards: LaunchCard[], options: LaunchOptions, project: string, worktree?: string, general: string[] = []): string[] {
  const args: string[] = [];
  if (options.model) args.push('--model', options.model);
  args.push('--effort', options.effort, '--name', sessionName(cards));
  if (options.worktree && worktree) args.push('--worktree', worktree);
  // `--` ends the options: the prompt is the one positional argument, whatever it starts with.
  args.push('--', launchPrompt(cards, options, project, general));
  return args;
}
