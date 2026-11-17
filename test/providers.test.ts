import { describe, expect, it } from 'vitest';
import { allProviders, isNativeSessionId, parseCustomAgent, providerArgs, providerFor, readCustomAgents } from '../src/providers';

const custom = { id: 'local-helper', label: 'Local Helper', command: '/some path/helper', args: ['--model', '{model}', '--prompt', '{prompt}'], resumeArgs: ['resume', '{sessionId}'] };

describe('agent providers', () => {
  it('offers the common coding agents and an extensible command registry', () => {
    expect(allProviders().map((p) => p.id)).toEqual(['claude', 'codex', 'gemini', 'opencode', 'aider', 'cursor']);
    expect(providerFor('local-helper', [custom])).toEqual(custom);
    expect(providerFor('removed')).toBeUndefined();
    expect(readCustomAgents([custom, custom, { ...custom, id: 'codex' }, null])).toEqual([custom]);
  });

  it('refuses ambiguous custom definitions and unknown placeholders', () => {
    for (const bad of [null, {}, { ...custom, id: '../outside' }, { ...custom, id: 'claude' }, { ...custom, command: '-flag' }, { ...custom, args: ['{unknown}'] }, { ...custom, args: ['--prompt'] }, { ...custom, resumeArgs: ['--latest'] }, { ...custom, args: ['{prompt}', '\0'] }]) expect(parseCustomAgent(bad)).toBeUndefined();
  });

  it('keeps adversarial prompt text in one argument, with no shell quoting or evaluation', () => {
    const prompt = '-flag; $(touch /tmp/nope) `whoami` "quoted"\nnew line';
    expect(providerArgs(providerFor('gemini')!, { prompt })).toEqual(['--prompt-interactive', prompt]);
    expect(providerArgs(custom, { prompt, model: 'local/model' })).toEqual(['--model', 'local/model', '--prompt', prompt]);
    expect(providerArgs(custom, { prompt })).toEqual(['--prompt', prompt]);
  });

  it('resumes with native IDs and keeps providers without resume honest', () => {
    expect(providerArgs(providerFor('codex')!, { sessionId: 'native-uuid' }, true)).toEqual(['resume', 'native-uuid']);
    expect(providerArgs(providerFor('opencode')!, { sessionId: 'ses_nativeId' }, true)).toEqual(['--session', 'ses_nativeId']);
    expect(providerArgs(providerFor('aider')!, { sessionId: 'not-a-session' }, true)).toBeUndefined();
    expect(isNativeSessionId('ses_nativeId')).toBe(true);
    for (const bad of ['-flag', '$(whoami)', 'id;command', 'id\nnew', 'id with space']) expect(isNativeSessionId(bad)).toBe(false);
  });
});
