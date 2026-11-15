import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ensureCockpitDir, parseConfig, readConfig, repoPath, resolveDelivery, resolveRoadmap } from '../src/data/cockpitDir';

describe('the board file', () => {
  const root = '/r';
  const has = (...files: string[]) => (path: string) => files.includes(path);

  it('is the first of: the config, .cockpit/roadmap.md, ROADMAP.md, else .cockpit/roadmap.md', () => {
    const both = has('/r/.cockpit/roadmap.md', '/r/ROADMAP.md');
    expect(resolveRoadmap(root, { delivery: 'auto', roadmap: 'docs/plan.md' }, both)).toEqual({ path: '/r/docs/plan.md', name: 'docs/plan.md' });
    expect(resolveRoadmap(root, { delivery: 'auto' }, both)).toEqual({ path: '/r/.cockpit/roadmap.md', name: '.cockpit/roadmap.md' });
    expect(resolveRoadmap(root, { delivery: 'auto' }, has('/r/ROADMAP.md'))).toEqual({ path: '/r/ROADMAP.md', name: 'ROADMAP.md' });
    expect(resolveRoadmap(root, { delivery: 'auto' }, has())).toEqual({ path: '/r/.cockpit/roadmap.md', name: '.cockpit/roadmap.md' });
  });

  it('may only be a path inside the repository', () => {
    expect(repoPath('ROADMAP.md')).toBe('ROADMAP.md');
    expect(repoPath(' ./docs//plan.md ')).toBe('docs/plan.md');
    expect(repoPath('docs\\plan.md')).toBe('docs/plan.md');
    for (const bad of ['', '.', '../x.md', 'docs/../../x.md', '/etc/passwd', 'C:/x.md', 42, null]) expect(repoPath(bad)).toBeUndefined();
  });
});

describe('the config', () => {
  it('reads delivery and roadmap, and leaves anything it does not understand at the default', () => {
    expect(parseConfig(undefined)).toEqual({ delivery: 'auto' });
    expect(parseConfig('not json')).toEqual({ delivery: 'auto' });
    expect(parseConfig('[1]')).toEqual({ delivery: 'auto' });
    expect(parseConfig('{ "delivery": "direct", "roadmap": "ROADMAP.md" }')).toEqual({ delivery: 'direct', roadmap: 'ROADMAP.md' });
    expect(parseConfig('{ "delivery": "pr" }')).toEqual({ delivery: 'pr' });
    expect(parseConfig('{ "delivery": "yolo", "roadmap": "../outside.md" }')).toEqual({ delivery: 'auto' });
  });

  it('resolves auto to pull requests when there is an origin, else direct; an explicit choice stays', () => {
    expect(resolveDelivery('auto', true)).toBe('pr');
    expect(resolveDelivery('auto', false)).toBe('direct');
    expect(resolveDelivery('direct', true)).toBe('direct');
    expect(resolveDelivery('pr', false)).toBe('pr');
  });
});

describe('.cockpit/', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-dir-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('is made with a .gitignore that ignores it all, which is never overwritten', async () => {
    expect(await readConfig(root)).toEqual({ delivery: 'auto' });
    const dir = await ensureCockpitDir(root);
    expect(dir).toBe(join(root, '.cockpit'));
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
    writeFileSync(join(dir, '.gitignore'), '*\n!roadmap.md\n');
    await ensureCockpitDir(root);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n!roadmap.md\n');
    writeFileSync(join(dir, 'config.json'), '{ "delivery": "pr" }');
    expect(await readConfig(root)).toEqual({ delivery: 'pr' });
  });
});
