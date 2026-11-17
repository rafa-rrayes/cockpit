import { describe, expect, it } from 'vitest';
import type { AgentSession } from '../src/model';
import { mergeAgentSessions } from '../src/sources';
import { compose } from '../src/compose';

const session = (over: Partial<AgentSession>): AgentSession => ({ sessionId: 'claude-id', live: false, status: 'ended',
  title: 'A task', cwd: '/work/app', projectKey: '/work/app', recentPrompts: [], subagents: [], workflows: [], ...over });

describe('provider-neutral discovery', () => {
  it('keeps matching native IDs from different providers distinct through composition', () => {
    const ss = mergeAgentSessions([
      session({ sessionId: 'same', nativeSessionId: 'same', provider: 'claude' }),
      session({ sessionId: 'codex:same', nativeSessionId: 'same', provider: 'codex' }),
      session({ sessionId: 'gemini:same', nativeSessionId: 'same', provider: 'gemini' }),
    ]);
    const state = compose({ now: 1, sessions: ss, workspaceProjectKey: '/work/app' });
    expect(Object.keys(state.sessions)).toEqual(['same', 'codex:same', 'gemini:same']);
    expect(state.projects[0]?.sessionIds).toHaveLength(3);
  });

  it('combines native transcript data with the exact resumed process and explicit hook status', () => {
    const native = session({ provider: 'codex', sessionId: 'codex:native', nativeSessionId: 'native',
      status: 'unknown', statusNote: 'History only', report: 'Native report', transcriptPath: '/session.jsonl' });
    const managed = session({ provider: 'codex', sessionId: 'managed:wrapper', nativeSessionId: 'native',
      live: true, pid: 123, status: 'waiting', waitingFor: 'Permission' });
    const [merged] = mergeAgentSessions([native, managed]);
    expect(merged).toMatchObject({ sessionId: 'codex:native', live: true, pid: 123, status: 'waiting',
      waitingFor: 'Permission', report: 'Native report', transcriptPath: '/session.jsonl' });
    expect(native).toMatchObject({ live: false, status: 'unknown' });
    expect(merged?.statusNote).toBeUndefined();
    const state = compose({ now: 1, sessions: [merged!], workspaceProjectKey: '/work/app' });
    expect(state.attention[0]).toMatchObject({ sessionId: 'codex:native', kind: 'session_waiting' });
  });

  it('does not guess session identity from a shared working folder', () => {
    const ss = mergeAgentSessions([
      session({ provider: 'codex', sessionId: 'codex:a', nativeSessionId: 'a' }),
      session({ provider: 'codex', sessionId: 'managed:b', live: true, status: 'unknown' }),
    ]);
    expect(ss).toHaveLength(2);
    expect(ss[0]?.live).toBe(false);
    expect(ss[1]?.live).toBe(true);
  });

  it('preserves native busy status when the wrapper has no activity telemetry', () => {
    const ss = mergeAgentSessions([
      session({ provider: 'codex', sessionId: 'codex:a', nativeSessionId: 'a', live: true, status: 'busy' }),
      session({ provider: 'codex', sessionId: 'managed:a', nativeSessionId: 'a', live: true, status: 'unknown' }),
    ]);
    expect(ss).toHaveLength(1);
    expect(ss[0]?.status).toBe('busy');
  });

  it('never replaces a newer native report with an older resumed-process report', () => {
    const native = session({ provider: 'codex', sessionId: 'codex:a', nativeSessionId: 'a', report: 'New native answer', updatedAt: 300 });
    const old = session({ provider: 'codex', sessionId: 'managed:old', nativeSessionId: 'a', report: 'Old answer', updatedAt: 100 });
    const recent = session({ provider: 'codex', sessionId: 'managed:recent', nativeSessionId: 'a', report: 'Recent old answer', updatedAt: 200 });
    for (const group of [[native, old, recent], [native, recent, old]]) {
      expect(mergeAgentSessions(group)[0]?.report).toBe('New native answer');
    }
    expect(mergeAgentSessions([native, { ...recent, updatedAt: 400, report: 'Latest hook answer' }])[0]?.report).toBe('Latest hook answer');
  });

  it('combines repeated custom-provider resumes deterministically without losing a live process', () => {
    const old = session({ provider: 'custom', sessionId: 'managed:a', nativeSessionId: 'a', startedAt: 1, updatedAt: 100, report: 'Old' });
    const latest = session({ provider: 'custom', sessionId: 'managed:b', nativeSessionId: 'a', startedAt: 2, updatedAt: 200, report: 'New', live: true, pid: 123, status: 'waiting', waitingFor: 'Permission' });
    for (const group of [[old, latest], [latest, old]]) {
      const ss = mergeAgentSessions(group);
      expect(ss).toHaveLength(1);
      expect(ss[0]).toMatchObject({ sessionId: 'managed:a', live: true, pid: 123, status: 'waiting', report: 'New' });
    }
  });
});
