// Smoke test: starts a real VS Code (downloaded by @vscode/test-electron into .vscode-test/) with this extension,
// a temporary git workspace and a copy of the Claude fixtures, then runs suite.ts inside it.
// VSCODE_EXECUTABLE=<path to a VS Code binary> uses that one instead of downloading.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const suite = join(root, '.vscode-test', 'smoke', 'suite.js');
await esbuild.build({
  entryPoints: [join(root, 'test/smoke/suite.ts')],
  outfile: suite,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  logLevel: 'warning',
});

const base = mkdtempSync(join(tmpdir(), 'cockpit-smoke-'));
const workspace = join(base, 'shop');
const claudeDir = join(base, 'claude');
cpSync(join(root, 'test/fixtures/claude'), claudeDir, { recursive: true });

// A small repository: main with a CHANGELOG, a merged branch and one with work on it.
const git = (...args) => execFileSync('git', ['-C', workspace, ...args], { stdio: 'pipe' });
execFileSync('git', ['init', '-q', '-b', 'main', workspace]);
git('config', 'user.email', 'smoke@example.com');
git('config', 'user.name', 'Smoke');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(workspace, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n- Something new.\n');
writeFileSync(join(workspace, 'package.json'), '{ "name": "shop", "version": "0.3.0" }\n');
git('add', '.');
git('commit', '-q', '-m', 'First commit');
git('branch', 'merged-feature');
git('checkout', '-q', '-b', 'wip');
writeFileSync(join(workspace, 'wip.txt'), 'work\n');
git('add', '.');
git('commit', '-q', '-m', 'Work in progress');
git('checkout', '-q', 'main');

let code = 0;
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
    launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes', `--user-data-dir=${join(base, 'user-data')}`],
    extensionTestsEnv: { CLAUDE_CONFIG_DIR: claudeDir, COCKPIT_SMOKE_WORKSPACE: workspace },
  });
} catch (e) {
  console.error('smoke test failed:', e instanceof Error ? e.message : e);
  code = 1;
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(code);
