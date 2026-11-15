import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

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
});
