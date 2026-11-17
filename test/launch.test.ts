import { describe, expect, it } from 'vitest';
import { agentLaunchArgs, defaultLaunch, launchArgs, launchEnv, launchPrompt, parseLaunchOptions, sessionName, worktreeName } from '../src/launch';
import type { LaunchOptions } from '../src/model';
import { providerFor } from '../src/providers';

const card = (text: string, lane = 'Backlog') => ({ text, lane });

describe('parseLaunchOptions', () => {
  it('accepts what the launcher sends', () => {
    expect(parseLaunchOptions(defaultLaunch)).toEqual(defaultLaunch);
    expect(parseLaunchOptions({ model: 'opus', effort: 'max', subagents: 3, worktree: true, markDoing: false })).toEqual({ model: 'opus', effort: 'max', subagents: 3, worktree: true, markDoing: false });
    // Subagents and effort are chosen apart.
    expect(parseLaunchOptions({ ...defaultLaunch, effort: 'low', subagents: 2 })).toEqual({ ...defaultLaunch, effort: 'low', subagents: 2 });
  });

  it('refuses anything else', () => {
    expect(parseLaunchOptions(undefined)).toBeUndefined();
    expect(parseLaunchOptions({ ...defaultLaunch, model: 'gpt' })).toBeUndefined();
    expect(parseLaunchOptions({ ...defaultLaunch, model: 'opus; rm -rf ~' })).toBeUndefined();
    expect(parseLaunchOptions({ ...defaultLaunch, effort: 'ultra' })).toBeUndefined();
    expect(parseLaunchOptions({ ...defaultLaunch, effort: 'max', subagents: 9 })).toBeUndefined();
    expect(parseLaunchOptions({ ...defaultLaunch, effort: 'max', subagents: 1.5 })).toBeUndefined();
  });

  it('reads anything but true as false', () => {
    expect(parseLaunchOptions({ effort: 'low', subagents: 0, worktree: 'yes' })).toEqual({ effort: 'low', subagents: 0, worktree: false, markDoing: false });
  });
});

describe('names', () => {
  it('makes a worktree name of the lane and the first card', () => {
    expect(worktreeName([card('Welcome link lifetime as an env var', '1.1.3')])).toBe('1.1.3-welcome-link-lifetime-as-an-env');
    expect(worktreeName([card('Dark mode for the board')])).toBe('backlog-dark-mode-for-the-board');
    expect(worktreeName([card('Exportar relatório em CSV!', '2.0.0-rc.1')])).toBe('2.0.0-rc.1-exportar-relatorio-em-csv');
    expect(worktreeName([card('A very long card text that keeps on going past any sensible branch name', '1.2.0')])).toBe('1.2.0-a-very-long-card-text-that-keeps');
    // A batch is named after its first card: the lane already says where it belongs.
    expect(worktreeName([card('Dark mode', '1.2.0'), card('CSV'), card('Search')])).toBe('1.2.0-dark-mode');
    expect(worktreeName([card('✨ 🚀', '1.2.0')])).toBe('1.2.0-roadmap');
    expect(worktreeName([card('supercalifragilisticexpialidocious-and-then-some')])).toBe('backlog-supercalifragilisticexpialidocio');
    expect(worktreeName([card('x', '..odd lane..')])).toBe('odd-lane-x');
  });

  it('names the session after the first card and the count', () => {
    expect(sessionName([card('Dark mode')])).toBe('Dark mode');
    expect(sessionName([card('Dark mode'), card('CSV')])).toBe('Dark mode (+1)');
    expect(sessionName([card('x'.repeat(80))])).toHaveLength(48);
  });
});

describe('the prompt and the command line', () => {
  const opts = (o: Partial<LaunchOptions> = {}): LaunchOptions => ({ ...defaultLaunch, ...o });

  it('lists the cards with their lanes and the standard', () => {
    const p = launchPrompt([card('Dark mode', '0.2.0')], opts(), 'shop');
    expect(p).toContain('Work on this card from the roadmap of shop:');
    expect(p).not.toContain('ROADMAP.md');
    expect(p).toContain('- Dark mode (0.2.0)');
    expect(p).toContain('CLAUDE.md');
    expect(p).toContain('new git worktree');
    expect(p).toContain('Commit on this branch');
    expect(p).toContain('Leave the roadmap file alone: Cockpit moves these cards.');
    expect(p).toContain('do not start subagents');
    expect(p).not.toContain('one batch');
  });

  it('batches several cards and asks for subagents when given', () => {
    const p = launchPrompt([card('Dark mode'), card('CSV export')], opts({ effort: 'max', subagents: 3 }), 'shop');
    expect(p).toContain('these 2 cards');
    expect(p).toContain('- CSV export (Backlog)');
    expect(p).toContain('The 2 cards are one batch');
    expect(p).toContain('Use up to 3 subagents in parallel');
  });

  it('leaves committing to the person in the main checkout', () => {
    const p = launchPrompt([card('Dark mode')], opts({ worktree: false }), 'shop');
    expect(p).toContain('You are in the main checkout');
    expect(p).toContain('Do not commit');
  });

  it('sends shipping and releasing through the cockpit command, with custom steps too', () => {
    const line = (p: string) => p.split('\n').find((l) => l.includes('Commit on this branch') || l.includes('Do not commit')) ?? '';
    for (const o of [opts(), opts({ worktree: false })]) {
      for (const general of [[], ['Be brief.']]) {
        const l = line(launchPrompt([card('Dark mode')], o, 'shop', general));
        expect(l.endsWith("don't do it by hand with git: run `cockpit status`, then `cockpit ship` or `cockpit release <version>`.")).toBe(true);
      }
    }
  });

  it('builds argv with the prompt after --', () => {
    const args = launchArgs([card('Dark mode')], opts({ model: 'opus', effort: 'xhigh' }), 'shop', 'dark-mode');
    expect(args.slice(0, -1)).toEqual(['--model', 'opus', '--effort', 'xhigh', '--name', 'Dark mode', '--worktree', 'dark-mode', '--']);
    expect(args.at(-1)).toContain('- Dark mode (Backlog)');
  });

  it('leaves out the model and the worktree when not chosen', () => {
    const args = launchArgs([card('- [x] looks like a flag')], opts({ worktree: false }), 'shop', 'ignored');
    expect(args.slice(0, -1)).toEqual(['--effort', 'high', '--name', '- [x] looks like a flag', '--']);
  });
});

describe('the subagent model', () => {
  const opts = (o: Partial<LaunchOptions> = {}): LaunchOptions => ({ ...defaultLaunch, ...o });

  it('is checked, and dropped without subagents', () => {
    expect(parseLaunchOptions(opts({ subagents: 2, subagentModel: 'haiku' }))?.subagentModel).toBe('haiku');
    expect(parseLaunchOptions(opts({ subagents: 0, subagentModel: 'haiku' }))?.subagentModel).toBeUndefined();
    expect(parseLaunchOptions({ ...opts({ subagents: 2 }), subagentModel: 'gpt' })).toBeUndefined();
  });

  it('is forced through the environment', () => {
    expect(launchEnv(opts({ subagents: 2, subagentModel: 'sonnet' }))).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    expect(launchEnv(opts({ subagents: 2 }))).toEqual({});
    expect(launchEnv(opts({ subagents: 0, subagentModel: 'sonnet' }))).toEqual({});
  });

  it('is named in the prompt', () => {
    expect(launchPrompt([{ text: 'x', lane: 'Backlog' }], opts({ subagents: 2, subagentModel: 'haiku' }), 'shop')).toContain('Every subagent runs on Haiku');
    expect(launchPrompt([{ text: 'x', lane: 'Backlog' }], opts({ subagents: 2 }), 'shop')).not.toContain('Every subagent runs on');
  });
});

describe('provider launch options', () => {
  it('accepts provider-specific model identifiers while retaining legacy Claude validation', () => {
    expect(parseLaunchOptions({ ...defaultLaunch, agent: 'codex', model: 'gpt-6.1-sol' })).toEqual({ ...defaultLaunch, agent: 'codex', model: 'gpt-6.1-sol' });
    expect(parseLaunchOptions({ ...defaultLaunch, agent: 'opencode', model: 'provider/model' })?.model).toBe('provider/model');
    expect(parseLaunchOptions({ ...defaultLaunch, agent: 'custom-helper', model: 'local:model' })?.agent).toBe('custom-helper');
    expect(parseLaunchOptions({ ...defaultLaunch, agent: '../bad' })).toBeUndefined();
    expect(parseLaunchOptions({ ...defaultLaunch, agent: 'codex', model: '--flag' })).toBeUndefined();
  });
  it('does not leak Claude-specific subagent environment into another provider', () => {
    expect(launchEnv({ ...defaultLaunch, agent: 'codex', subagents: 2, subagentModel: 'sonnet' })).toEqual({});
  });
});


describe('non-Claude launch argv', () => {
  it('passes Codex effort and model without Claude flags or an invented worktree argument', () => {
    expect(agentLaunchArgs(providerFor('codex')!, 'a prompt; still one arg', { ...defaultLaunch, agent: 'codex', model: 'gpt-6.1-sol', effort: 'max' })).toEqual(['-c', 'model_reasoning_effort="xhigh"', '--model', 'gpt-6.1-sol', '--', 'a prompt; still one arg']);
  });
  it('does not send unsupported thinking controls to Gemini or custom agents', () => {
    expect(agentLaunchArgs(providerFor('gemini')!, 'task', { ...defaultLaunch, agent: 'gemini', effort: 'max' })).toEqual(['--prompt-interactive', 'task']);
  });
});
