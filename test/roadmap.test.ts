import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyRoadmapEdit, finishBranch, finishMerged, isMemberName, linkCard, nextMinor, normalizeDuration, parseRoadmap, setLaneStatus, starterRoadmap } from '../src/data/roadmap';
import { parseRoadmapEdit } from '../src/guards';
import type { RoadmapEdit } from '../src/model';

const fixture = readFileSync(join(__dirname, 'fixtures/releases/ROADMAP.md'), 'utf8');

const DOC = `# Roadmap

Some words that must survive every edit.

## 1.2.0 — Comunidade
Target: week of 2026-11-16

- [x] Seasons
- [~] Video feed
  wrapped text of the video feed
- [ ] Comments

## 1.3.0

## Notes

- not a card

## Backlog

- [ ] Tablet layout
`;

/** The id of the card with this text. */
function id(text: string, card: string): string {
  const item = parseRoadmap(text)
    .flatMap((l) => l.items)
    .find((i) => i.text === card);
  if (!item) throw new Error(`no card "${card}"`);
  return item.id;
}

function edit(text: string, e: RoadmapEdit): string {
  const r = applyRoadmapEdit(text, e);
  if (!r.ok) throw new Error(r.error);
  return r.text;
}

const board = (text: string) => parseRoadmap(text).map((l) => [l.version, ...l.items.map((i) => `${i.status}:${i.text}`)]);

describe('parseRoadmap: the board', () => {
  it('reads statuses, the backlog lane and stable ids', () => {
    expect(board(DOC)).toEqual([
      ['1.2.0', 'done:Seasons', 'doing:Video feed', 'todo:Comments'],
      ['1.3.0'],
      ['Backlog', 'todo:Tablet layout'],
    ]);
    expect(parseRoadmap(DOC)[2]).toMatchObject({ backlog: true });
    expect(parseRoadmap('## 1.0\n- [/] a\n- [-] b\n- c\n')[0]?.items.map((i) => i.status)).toEqual(['doing', 'doing', 'todo']);
    expect(id(DOC, 'Seasons')).toBe(id(DOC, 'Seasons'));
  });

  it('reads "Later" in the fixture as the backlog, and other headings end a lane', () => {
    const later = parseRoadmap(fixture).find((l) => l.backlog);
    expect(later).toMatchObject({ version: 'Later', items: [{ text: 'Dark mode' }, { text: 'Offline mode' }] });
    expect(parseRoadmap(DOC).flatMap((l) => l.items.map((i) => i.text))).not.toContain('not a card');
  });
});

describe('applyRoadmapEdit', () => {
  it('adds a card after the last one of its lane', () => {
    const out = edit(DOC, { op: 'add', lane: '1.2.0', text: '  Likes \n on videos ' });
    expect(out).toBe(DOC.replace('- [ ] Comments\n', '- [ ] Comments\n- [ ] Likes on videos\n'));
  });

  it('adds the first card of an empty lane with a blank line on each side', () => {
    const out = edit(DOC, { op: 'add', lane: '1.3.0', text: 'Site builder' });
    expect(out).toBe(DOC.replace('## 1.3.0\n\n## Notes', '## 1.3.0\n\n- [ ] Site builder\n\n## Notes'));
    expect(edit('## 1.0\n## 2.0\n', { op: 'add', lane: '1.0', text: 'a' })).toBe('## 1.0\n\n- [ ] a\n\n## 2.0\n');
    expect(edit('## 1.0\nTarget: soon', { op: 'add', lane: '1.0', text: 'a' })).toBe('## 1.0\nTarget: soon\n\n- [ ] a');
  });

  it('creates the Backlog when a card is added to it and it is missing', () => {
    expect(edit('# Roadmap\n\n## 1.0\n\n- [ ] a\n', { op: 'add', lane: 'Backlog', text: 'b' })).toBe('# Roadmap\n\n## 1.0\n\n- [ ] a\n\n## Backlog\n\n- [ ] b\n');
    expect(applyRoadmapEdit(DOC, { op: 'add', lane: '9.9.9', text: 'x' })).toMatchObject({ ok: false });
    expect(applyRoadmapEdit(DOC, { op: 'add', lane: '1.2.0', text: '   ' })).toMatchObject({ ok: false });
  });

  it('renames a card and changes its status in place, keeping its bullet and the rest of the file', () => {
    expect(edit(DOC, { op: 'setText', id: id(DOC, 'Comments'), text: 'Comments and replies' })).toBe(DOC.replace('- [ ] Comments', '- [ ] Comments and replies'));
    expect(edit(DOC, { op: 'setStatus', id: id(DOC, 'Comments'), status: 'doing' })).toBe(DOC.replace('- [ ] Comments', '- [~] Comments'));
    expect(edit(DOC, { op: 'setStatus', id: id(DOC, 'Video feed'), status: 'done' })).toBe(DOC.replace('- [~] Video feed', '- [x] Video feed'));
    // A plain item gets a checkbox; "*" stays "*".
    expect(edit('## 1.0\n* plain\n', { op: 'setStatus', id: id('## 1.0\n* plain\n', 'plain'), status: 'done' })).toBe('## 1.0\n* [x] plain\n');
    expect(edit('## 1.0\n* plain\n', { op: 'setText', id: id('## 1.0\n* plain\n', 'plain'), text: 'still plain' })).toBe('## 1.0\n* still plain\n');
  });

  it('removes a card with its wrapped lines', () => {
    expect(edit(DOC, { op: 'remove', id: id(DOC, 'Video feed') })).toBe(DOC.replace('- [~] Video feed\n  wrapped text of the video feed\n', ''));
  });

  it('moves a card to another lane, to its end or before a card, with its wrapped lines', () => {
    const toBacklog = edit(DOC, { op: 'move', id: id(DOC, 'Video feed'), lane: 'Backlog', status: 'todo' });
    expect(board(toBacklog)).toEqual([
      ['1.2.0', 'done:Seasons', 'todo:Comments'],
      ['1.3.0'],
      ['Backlog', 'todo:Tablet layout', 'todo:Video feed'],
    ]);
    expect(toBacklog).toContain('- [ ] Tablet layout\n- [ ] Video feed\n  wrapped text of the video feed\n');

    const up = edit(DOC, { op: 'move', id: id(DOC, 'Tablet layout'), lane: '1.2.0', status: 'doing', before: id(DOC, 'Seasons') });
    expect(board(up)[0]).toEqual(['1.2.0', 'doing:Tablet layout', 'done:Seasons', 'doing:Video feed', 'todo:Comments']);

    const down = edit(DOC, { op: 'move', id: id(DOC, 'Seasons'), lane: '1.2.0', status: 'done', before: id(DOC, 'Comments') });
    expect(board(down)[0]).toEqual(['1.2.0', 'doing:Video feed', 'done:Seasons', 'todo:Comments']);

    const empty = edit(DOC, { op: 'move', id: id(DOC, 'Comments'), lane: '1.3.0', status: 'todo' });
    expect(board(empty)[1]).toEqual(['1.3.0', 'todo:Comments']);
  });

  it('keeps every other line of the file through a move', () => {
    const out = edit(DOC, { op: 'move', id: id(DOC, 'Comments'), lane: 'Backlog', status: 'todo' });
    const rest = (t: string) => t.split('\n').filter((l) => !l.includes('Comments'));
    expect(rest(out)).toEqual(rest(DOC));
  });

  it('only changes the status when a card is dropped on itself', () => {
    const self = id(DOC, 'Comments');
    expect(edit(DOC, { op: 'move', id: self, lane: '1.2.0', status: 'done', before: self })).toBe(DOC.replace('- [ ] Comments', '- [x] Comments'));
  });

  it('un-nests a nested item that moves to the end of a lane', () => {
    const nested = '## 1.0\n- [ ] parent\n  - [ ] child\n\n## 2.0\n';
    expect(edit(nested, { op: 'move', id: id(nested, 'child'), lane: '2.0', status: 'todo' })).toBe('## 1.0\n- [ ] parent\n\n## 2.0\n\n- [ ] child\n');
  });

  it('adds a release above the backlog, or at the end', () => {
    expect(edit(DOC, { op: 'addRelease', version: 'v1.4.0', title: 'Reports' })).toBe(DOC.replace('## Backlog', '## 1.4.0 — Reports\n\n## Backlog'));
    expect(edit('# Roadmap\n\n## 1.0\n- a\n', { op: 'addRelease', version: '1.1' })).toBe('# Roadmap\n\n## 1.0\n- a\n\n## 1.1\n');
    expect(applyRoadmapEdit(DOC, { op: 'addRelease', version: '1.2.0' })).toMatchObject({ ok: false });
    expect(applyRoadmapEdit(DOC, { op: 'addRelease', version: 'soon' })).toMatchObject({ ok: false });
    expect(applyRoadmapEdit(DOC, { op: 'addRelease', version: '1.5\n## injected' })).toMatchObject({ ok: false });
  });

  it('follows a card whose line moved, and refuses one that changed or is ambiguous', () => {
    const stale = id(DOC, 'Comments');
    // Lines were added above: the id's line number is wrong, its content is still unique.
    const shifted = DOC.replace('# Roadmap\n', '# Roadmap\n\nA new paragraph.\n');
    expect(edit(shifted, { op: 'setStatus', id: stale, status: 'done' })).toBe(shifted.replace('- [ ] Comments', '- [x] Comments'));
    // The card was renamed by someone else.
    expect(applyRoadmapEdit(DOC.replace('Comments', 'Replies'), { op: 'remove', id: stale })).toMatchObject({ ok: false });
    // Two identical lines, neither on the id's line.
    const twins = `\n${DOC.replace('## 1.3.0\n', '## 1.3.0\n- [ ] Comments\n')}`;
    expect(applyRoadmapEdit(twins, { op: 'remove', id: stale })).toMatchObject({ ok: false });
    expect(applyRoadmapEdit(DOC, { op: 'move', id: stale, lane: 'Backlog', status: 'todo', before: '99:zzz' })).toMatchObject({ ok: false });
  });

  it('keeps CRLF line endings', () => {
    const crlf = DOC.replace(/\n/g, '\r\n');
    const out = edit(crlf, { op: 'add', lane: 'Backlog', text: 'x' });
    expect(out).toBe(crlf.replace('- [ ] Tablet layout\r\n', '- [ ] Tablet layout\r\n- [ ] x\r\n'));
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('survives a long sequence of edits on the fixture without touching its prose', () => {
    let text = fixture;
    text = edit(text, { op: 'add', lane: '2.0.0', text: 'New engine' });
    text = edit(text, { op: 'move', id: id(text, 'Payouts'), lane: '2.0.0', status: 'doing', before: id(text, 'New engine') });
    text = edit(text, { op: 'setText', id: id(text, 'Dark mode'), text: 'Dark theme' });
    text = edit(text, { op: 'remove', id: id(text, 'Offline mode') });
    text = edit(text, { op: 'addRelease', version: '3.0.0' });
    expect(text).toContain('What ships next. Each release is a heading, then its target, status and features.');
    expect(text).toContain('**Target:** December');
    const lanes = Object.fromEntries(parseRoadmap(text).map((l) => [l.version, l.items.map((i) => `${i.status}:${i.text}`)]));
    expect(lanes['2.0.0']).toEqual(['doing:Payouts', 'todo:New engine']);
    expect(lanes['1.3.0']).toEqual(['todo:Card checkout in USD']);
    expect(lanes.Later).toEqual(['todo:Dark theme']);
    expect(lanes['3.0.0']).toEqual([]);
  });
});

describe('branch links', () => {
  const LINKED = DOC.replace('- [~] Video feed\n', '- [~] Video feed <!-- cockpit:worktree-1.2.0-video-feed -->\n');
  const video = () => parseRoadmap(LINKED)[0]?.items.find((i) => i.text === 'Video feed');
  const lineOf = (text: string, card: string) => text.split('\n').find((l) => l.includes(card));

  it('reads the link as the card branch, out of its text', () => {
    expect(video()).toMatchObject({ text: 'Video feed', status: 'doing', branch: 'worktree-1.2.0-video-feed' });
    expect(parseRoadmap(DOC)[0]?.items.find((i) => i.text === 'Video feed')?.branch).toBeUndefined();
    // Only at the end of the line, and only Cockpit's.
    expect(parseRoadmap('## 1.0\n- [ ] a <!-- cockpit:b --> more\n- [ ] c <!-- note -->\n')[0]?.items.map((i) => [i.text, i.branch])).toEqual([
      ['a <!-- cockpit:b --> more', undefined],
      ['c <!-- note -->', undefined],
    ]);
  });

  it('keeps the link through a rename, a status change, a move to another lane and a drag before a card', () => {
    const vid = id(LINKED, 'Video feed');
    const renamed = edit(LINKED, { op: 'setText', id: vid, text: 'Video feed v2' });
    expect(lineOf(renamed, 'Video feed')).toBe('- [~] Video feed v2 <!-- cockpit:worktree-1.2.0-video-feed -->');
    expect(lineOf(edit(LINKED, { op: 'setStatus', id: vid, status: 'done' }), 'Video feed')).toBe('- [x] Video feed <!-- cockpit:worktree-1.2.0-video-feed -->');
    const moved = edit(LINKED, { op: 'move', id: vid, lane: 'Backlog', status: 'todo' });
    expect(lineOf(moved, 'Video feed')).toBe('- [ ] Video feed <!-- cockpit:worktree-1.2.0-video-feed -->');
    expect(moved).toContain('<!-- cockpit:worktree-1.2.0-video-feed -->\n  wrapped text of the video feed');
    const dragged = edit(LINKED, { op: 'move', id: vid, lane: '1.2.0', status: 'doing', before: id(LINKED, 'Seasons') });
    expect(parseRoadmap(dragged)[0]?.items[0]).toMatchObject({ text: 'Video feed', branch: 'worktree-1.2.0-video-feed' });
  });

  it('drops a link typed into a card text', () => {
    const typed = edit(DOC, { op: 'setText', id: id(DOC, 'Comments'), text: 'Comments <!-- cockpit:evil -->' });
    expect(lineOf(typed, 'Comments')).toBe('- [ ] Comments');
    expect(edit(DOC, { op: 'add', lane: 'Backlog', text: 'x <!-- cockpit:y -->' })).toContain('- [ ] x\n');
  });

  it('links a card, replacing its old link, and refuses a name that is not a branch', () => {
    const linked = linkCard(DOC, id(DOC, 'Comments'), 'worktree-1.2.0-comments', 'doing');
    expect(linked.ok && lineOf(linked.text, 'Comments')).toBe('- [~] Comments <!-- cockpit:worktree-1.2.0-comments -->');
    const relinked = linkCard(LINKED, id(LINKED, 'Video feed'), 'other');
    expect(relinked.ok && lineOf(relinked.text, 'Video feed')).toBe('- [~] Video feed <!-- cockpit:other -->');
    expect(linkCard(DOC, id(DOC, 'Comments'), 'a --> b')).toMatchObject({ ok: false });
    expect(linkCard(DOC, '99:zzz', 'b')).toMatchObject({ ok: false });
  });

  it('finishes the cards of a branch: done and unlinked, everything else as it was', () => {
    const two = LINKED.replace('- [ ] Tablet layout', '- [ ] Tablet layout <!-- cockpit:worktree-1.2.0-video-feed -->').replace('- [ ] Comments', '- [ ] Comments <!-- cockpit:other -->');
    const out = finishBranch(two, 'worktree-1.2.0-video-feed');
    expect(out).toBe(two.replace('- [~] Video feed <!-- cockpit:worktree-1.2.0-video-feed -->', '- [x] Video feed').replace('- [ ] Tablet layout <!-- cockpit:worktree-1.2.0-video-feed -->', '- [x] Tablet layout'));
    expect(finishBranch(DOC, 'nothing-linked')).toBe(DOC);
  });

  it('finishes what merged: the cards of every merged branch, and each merged release shipped', () => {
    const text = '## 0.2.0\n\n- [~] a <!-- cockpit:wa -->\n- [~] b <!-- cockpit:wb -->\n\n## 0.3.0\n\n- [ ] c <!-- cockpit:wc -->\n';
    expect(finishMerged(text, { branches: ['wa', 'wc'], versions: ['0.2.0', '9.9.9'] })).toBe('## 0.2.0\nStatus: shipped\n\n- [x] a\n- [~] b <!-- cockpit:wb -->\n\n## 0.3.0\n\n- [x] c\n');
    expect(finishMerged(text, { branches: [], versions: [] })).toBe(text);
  });

  it("sets a release's status, rewriting the line it has or adding one under the heading", () => {
    const st = (text: string, v: string) => {
      const r = setLaneStatus(text, v, 'shipped');
      if (!r.ok) throw new Error(r.error);
      return r.text;
    };
    expect(st(DOC, '1.3.0')).toBe(DOC.replace('## 1.3.0\n', '## 1.3.0\nStatus: shipped\n'));
    expect(st(DOC, '1.2.0')).toBe(DOC.replace('Target: week of 2026-11-16\n', 'Target: week of 2026-11-16\nStatus: shipped\n'));
    expect(st('## 1.0\nStatus: in progress\n- [x] a\n', '1.0')).toBe('## 1.0\nStatus: shipped\n- [x] a\n');
    expect(st('## 1.0\n**Status:** in progress\n', '1.0')).toBe('## 1.0\n**Status:** shipped\n');
    expect(setLaneStatus(DOC, 'Backlog', 'shipped')).toMatchObject({ ok: false });
  });
});

describe('a new roadmap', () => {
  it('starts with the next minor release and a backlog', () => {
    expect(nextMinor('1.1.0')).toBe('1.2.0');
    expect(nextMinor(undefined)).toBe('0.1.0');
    expect(board(starterRoadmap('1.1.0'))).toEqual([['1.2.0'], ['Backlog']]);
    expect(applyRoadmapEdit(starterRoadmap(), { op: 'create' })).toMatchObject({ ok: false });
  });
});

describe('parseRoadmapEdit', () => {
  it('accepts well-formed edits and drops unknown fields', () => {
    expect(parseRoadmapEdit({ op: 'move', id: '3:abc', lane: '1.2.0', status: 'doing', before: '5:def', extra: 1 })).toEqual({ op: 'move', id: '3:abc', lane: '1.2.0', status: 'doing', before: '5:def' });
    expect(parseRoadmapEdit({ op: 'add', lane: 'Backlog', text: 'x' })).toEqual({ op: 'add', lane: 'Backlog', text: 'x' });
    expect(parseRoadmapEdit({ op: 'create' })).toEqual({ op: 'create' });
  });

  it('refuses anything else', () => {
    expect(parseRoadmapEdit({ op: 'setStatus', id: '1:a', status: 'archived' })).toBeUndefined();
    expect(parseRoadmapEdit({ op: 'add', lane: 'Backlog' })).toBeUndefined();
    expect(parseRoadmapEdit({ op: 'add', lane: 'Backlog', text: 'x'.repeat(2000) })).toBeUndefined();
    expect(parseRoadmapEdit({ op: 'drop-table' })).toBeUndefined();
    expect(parseRoadmapEdit('add')).toBeUndefined();
  });
});

describe('assignment and duration', () => {
  const META = '## 1.0\n\n- [~] Feed <!-- cockpit:who=Rafa --> <!-- cockpit:time=2h --> <!-- cockpit:worktree-1.0-feed -->\n- [ ] Plain\n';

  it('reads who and how long from the comments, outside the text', () => {
    const [feed, plain] = parseRoadmap(META)[0]?.items ?? [];
    expect(feed).toMatchObject({ text: 'Feed', who: 'Rafa', duration: '2h', branch: 'worktree-1.0-feed', status: 'doing' });
    expect(plain).not.toHaveProperty('who');
    expect(plain).not.toHaveProperty('duration');
  });

  it('reads them in any order, and leaves a comment it does not know in the text', () => {
    const [a] = parseRoadmap('## 1.0\n- [ ] A <!-- cockpit:b --> <!-- cockpit:time=1d -->\n')[0]?.items ?? [];
    expect(a).toMatchObject({ text: 'A', branch: 'b', duration: '1d' });
    const [b] = parseRoadmap('## 1.0\n- [ ] B <!-- cockpit:who=<x> -->\n')[0]?.items ?? [];
    expect(b?.who).toBeUndefined();
    expect(b?.text).toContain('cockpit:who');
  });

  it('assigns, reassigns and unassigns, writing who before the time and the link', () => {
    const one = edit(DOC, { op: 'assign', id: id(DOC, 'Comments'), who: 'Claude' });
    expect(one).toBe(DOC.replace('- [ ] Comments', '- [ ] Comments <!-- cockpit:who=Claude -->'));
    const linked = linkCard(one, id(one, 'Comments'), 'b');
    if (!linked.ok) throw new Error(linked.error);
    expect(linked.text).toContain('- [ ] Comments <!-- cockpit:who=Claude --> <!-- cockpit:b -->');
    const timed = edit(linked.text, { op: 'setDuration', id: id(linked.text, 'Comments'), duration: '90 min' });
    expect(timed).toContain('- [ ] Comments <!-- cockpit:who=Claude --> <!-- cockpit:time=90m --> <!-- cockpit:b -->');
    const re = edit(timed, { op: 'assign', id: id(timed, 'Comments'), who: 'Rafa Rayes' });
    expect(re).toContain('- [ ] Comments <!-- cockpit:who=Rafa Rayes --> <!-- cockpit:time=90m --> <!-- cockpit:b -->');
    const unassigned = edit(re, { op: 'assign', id: id(re, 'Comments') });
    const none = edit(unassigned, { op: 'setDuration', id: id(unassigned, 'Comments') });
    expect(none).toContain('- [ ] Comments <!-- cockpit:b -->\n');
  });

  it('keeps them through a rename, a status change, a move and the end of the branch', () => {
    const renamed = edit(META, { op: 'setText', id: id(META, 'Feed'), text: 'Video feed' });
    expect(renamed).toContain('- [~] Video feed <!-- cockpit:who=Rafa --> <!-- cockpit:time=2h --> <!-- cockpit:worktree-1.0-feed -->');
    expect(edit(META, { op: 'setStatus', id: id(META, 'Feed'), status: 'todo' })).toContain('- [ ] Feed <!-- cockpit:who=Rafa -->');
    const moved = edit(META, { op: 'move', id: id(META, 'Feed'), lane: 'Backlog', status: 'todo' });
    expect(parseRoadmap(moved).find((l) => l.backlog)?.items[0]).toMatchObject({ text: 'Feed', who: 'Rafa', duration: '2h' });
    expect(finishBranch(META, 'worktree-1.0-feed')).toContain('- [x] Feed <!-- cockpit:who=Rafa --> <!-- cockpit:time=2h -->\n');
  });

  it('refuses a name or a duration it cannot write', () => {
    expect(applyRoadmapEdit(DOC, { op: 'assign', id: id(DOC, 'Comments'), who: 'a --> b' })).toMatchObject({ ok: false });
    expect(applyRoadmapEdit(DOC, { op: 'setDuration', id: id(DOC, 'Comments'), duration: 'soon' })).toMatchObject({ ok: false });
    expect(applyRoadmapEdit(DOC, { op: 'assign', id: '99:zzz', who: 'Rafa' })).toMatchObject({ ok: false });
  });

  it('normalizes durations', () => {
    expect(normalizeDuration('2h')).toBe('2h');
    expect(normalizeDuration(' 1h 30min ')).toBe('1h30m');
    expect(normalizeDuration('2 Days')).toBe('2d');
    expect(normalizeDuration('1.5')).toBe('1.5h');
    expect(normalizeDuration('1w2d')).toBe('1w2d');
    for (const bad of ['', '0h', 'soon', '2x', 'h', '2h-']) expect(normalizeDuration(bad)).toBeUndefined();
  });

  it('knows what a member name may be', () => {
    for (const ok of ['Rafa', 'Claude', 'Rafa Rayes', "O'Neil", 'José', 'a.b']) expect(isMemberName(ok)).toBe(true);
    for (const bad of ['', ' Rafa', 'Rafa ', 'a-->', 'a<b', 'a=b', 'x'.repeat(41), 'a--b']) expect(isMemberName(bad)).toBe(false);
  });

  it('parses the edits the webview sends', () => {
    expect(parseRoadmapEdit({ op: 'assign', id: '1:a', who: 'Rafa' })).toEqual({ op: 'assign', id: '1:a', who: 'Rafa' });
    expect(parseRoadmapEdit({ op: 'assign', id: '1:a' })).toEqual({ op: 'assign', id: '1:a' });
    expect(parseRoadmapEdit({ op: 'assign', id: '1:a', who: 'a-->' })).toBeUndefined();
    expect(parseRoadmapEdit({ op: 'setDuration', id: '1:a', duration: '2h' })).toEqual({ op: 'setDuration', id: '1:a', duration: '2h' });
    expect(parseRoadmapEdit({ op: 'setDuration', id: '1:a' })).toEqual({ op: 'setDuration', id: '1:a' });
    expect(parseRoadmapEdit({ op: 'setDuration', id: '1:a', duration: 3 })).toBeUndefined();
  });
});
