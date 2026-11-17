// Executable and argv templates for each agent. No shell interprets prompts or session IDs.
export interface AgentProvider {
  id: string;
  label: string;
  command: string;
  args: string[];
  resumeArgs?: string[];
  supportsEffort?: boolean;
  modelFlag?: string;
  note?: string;
}

export type CustomAgent = Pick<AgentProvider, 'id' | 'label' | 'command' | 'args' | 'resumeArgs'>;

export const BUILTIN_PROVIDERS: readonly AgentProvider[] = [
  { id: 'claude', label: 'Claude Code', command: 'claude', args: ['--', '{prompt}'], resumeArgs: ['--resume', '{sessionId}'], supportsEffort: true, modelFlag: '--model' },
  { id: 'codex', label: 'Codex', command: 'codex', args: ['--', '{prompt}'], resumeArgs: ['resume', '{sessionId}'], supportsEffort: true, modelFlag: '--model' },
  { id: 'gemini', label: 'Gemini CLI', command: 'gemini', args: ['--prompt-interactive', '{prompt}'], resumeArgs: ['--resume', '{sessionId}'], modelFlag: '--model' },
  { id: 'opencode', label: 'OpenCode', command: 'opencode', args: ['--prompt', '{prompt}'], resumeArgs: ['--session', '{sessionId}'], modelFlag: '--model' },
  { id: 'aider', label: 'Aider', command: 'aider', args: ['--message', '{prompt}'], modelFlag: '--model', note: 'Runs one task, then exits. Use a custom command to choose a different Aider workflow.' },
  { id: 'cursor', label: 'Cursor Agent', command: 'cursor-agent', args: ['--', '{prompt}'], resumeArgs: ['--resume', '{sessionId}'], modelFlag: '--model' },
];

export const isProviderId = (v: unknown): v is string => typeof v === 'string' && /^[a-z][a-z0-9-]{0,39}$/.test(v);
export const isNativeSessionId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(v);
export const isModelName = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:@+-]{0,159}$/.test(v);
const argument = (v: unknown): v is string => typeof v === 'string' && v.length <= 4000 && !v.includes('\0') && !/[\r\n]/.test(v) && !/\{(?!prompt\}|sessionId\}|model\})/.test(v);
const argv = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 80 && v.every(argument);

export function parseCustomAgent(v: unknown): CustomAgent | undefined {
  if (typeof v !== 'object' || !v || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  if (!isProviderId(o.id) || BUILTIN_PROVIDERS.some((p) => p.id === o.id)) return undefined;
  if (typeof o.label !== 'string' || !o.label.trim() || o.label.length > 60 || /[\r\n\0]/.test(o.label)) return undefined;
  if (typeof o.command !== 'string' || !o.command.trim() || o.command.startsWith('-') || o.command.length > 500 || /[\r\n\0]/.test(o.command)) return undefined;
  if (!argv(o.args) || !o.args.some((a) => a.includes('{prompt}'))) return undefined;
  if (o.resumeArgs !== undefined && (!argv(o.resumeArgs) || !o.resumeArgs.some((a) => a.includes('{sessionId}')))) return undefined;
  return { id: o.id, label: o.label.trim(), command: o.command, args: [...o.args], ...(o.resumeArgs ? { resumeArgs: [...o.resumeArgs as string[]] } : {}) };
}

export function readCustomAgents(v: unknown): CustomAgent[] {
  if (!Array.isArray(v)) return [];
  const out: CustomAgent[] = [];
  for (const item of v.slice(0, 20)) {
    const p = parseCustomAgent(item);
    if (p && !out.some((x) => x.id === p.id)) out.push(p);
  }
  return out;
}

export const allProviders = (custom: CustomAgent[] = []): AgentProvider[] => [...BUILTIN_PROVIDERS, ...readCustomAgents(custom)];
export const providerFor = (id = 'claude', custom: CustomAgent[] = []): AgentProvider | undefined => allProviders(custom).find((p) => p.id === id);
export const providerLabel = (id = 'claude', custom: CustomAgent[] = []): string => providerFor(id, custom)?.label ?? id;

/** Placeholder expansion preserves each argument, including a prompt containing spaces or shell syntax. */
export function providerArgs(provider: AgentProvider, values: { prompt?: string; sessionId?: string; model?: string }, resume = false): string[] | undefined {
  const template = resume ? provider.resumeArgs : provider.args;
  if (!template) return undefined;
  const args: string[] = [];
  for (const part of template) {
    if (part.includes('{model}') && !values.model) {
      // A common custom template is ['--model', '{model}']; omit the pair when using the agent default.
      if (part === '{model}' && args.at(-1)?.startsWith('-')) args.pop();
      continue;
    }
    args.push(part.replace(/\{(prompt|sessionId|model)\}/g, (_, key: keyof typeof values) => values[key] ?? ''));
  }
  if (!resume && values.model && provider.modelFlag) args.unshift(provider.modelFlag, values.model);
  return args;
}
