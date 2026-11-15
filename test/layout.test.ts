import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Work } from '../src/model';
import { deliveryText, finishAction, releaseAction } from '../webview/format';

const css = readFileSync(join(__dirname, '..', 'webview', 'styles.css'), 'utf8');

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (!m?.[1]) throw new Error(`no rule for ${selector}`);
  return m[1];
}

describe('page layout', () => {
  // Maximized on a wide screen, the page fills the whole tab instead of a centred column.
  it.each(['.sections', '.topbar-row'])('%s has no width cap', (selector) => {
    expect(rule(selector)).not.toMatch(/max-width/);
  });

  // An unavailable action stays on screen, dimmed, instead of disappearing.
  it('dims a button that is aria-disabled', () => {
    expect(rule(".btn[aria-disabled='true']")).toMatch(/opacity/);
  });
});

const work = (over: Partial<Work>): Work => ({ available: true, defaultBranch: 'main', hasOrigin: false, delivery: 'direct', items: [], ciRuns: [], ...over });

describe('actions follow the delivery mode', () => {
  it('direct: finishing a branch merges it into the default branch, by its real name', () => {
    const face = finishAction(work({ defaultBranch: 'trunk' }), 'feat/x');
    expect(face).toMatchObject({ label: 'Merge into trunk…', icon: 'merge' });
    expect(face.title).toContain('Merges feat/x into trunk in the main checkout');
    expect(face.title).not.toContain('origin');
    expect(finishAction(work({ hasOrigin: true }), 'feat/x').title).toContain('pushes main to origin');
  });

  it('pr: finishing a branch ships it as a pull request', () => {
    const face = finishAction(work({ delivery: 'pr', hasOrigin: true, github: 'o/r' }), 'feat/x');
    expect(face).toMatchObject({ label: 'Ship…', icon: 'pr' });
    expect(face.title).toContain('opens its pull request');
  });

  it('release: direct commits and tags on the default branch, pr prepares a pull request', () => {
    expect(releaseAction(work({}), '1.2.0', 'release').title).toMatch(/^Bumps the version, dates the changelog, commits on main and tags v1\.2\.0/);
    expect(releaseAction(work({ hasOrigin: true }), '1.2.0', 'release').title).toContain('then pushes both');
    expect(releaseAction(work({ delivery: 'pr' }), '1.2.0', 'release').title).toContain('release pull request');
    expect(releaseAction(work({}), '1.2.0', 'tag')).toMatchObject({ label: 'Tag v1.2.0…', title: 'Tags the tip of main as v1.2.0, after a confirmation' });
    expect(releaseAction(work({ delivery: 'pr' }), '1.2.0', 'tag').title).toContain('pushes the tag');
  });

  it('the Work header names the mode', () => {
    expect(deliveryText(work({})).text).toBe('direct · local');
    expect(deliveryText(work({ hasOrigin: true })).text).toBe('direct · origin');
    expect(deliveryText(work({ delivery: 'pr', hasOrigin: true, github: 'owner/repo' })).text).toBe('pull requests · owner/repo');
    expect(deliveryText(work({ delivery: 'pr', hasOrigin: true })).text).toBe('pull requests · origin');
  });
});
