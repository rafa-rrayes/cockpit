// Smoke test: starts a real VS Code (downloaded by @vscode/test-electron into .vscode-test/) with this extension,
// a temporary git workspace and a copy of the Claude fixtures, then runs suite.ts inside it.
// VSCODE_EXECUTABLE=<path to a VS Code binary> uses that one instead of downloading.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
// Inside the extension's folder (dist/ is never a link to elsewhere): VS Code then gives the suite the extension's
// own vscode module, so a dialog the suite stubs is the one the extension calls.
const suite = join(root, 'dist', 'smoke', 'suite.js');
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
const codexDir = join(base, 'codex');
const geminiDir = join(base, 'gemini');
const cockpitDir = join(base, 'cockpit');
for (const path of [codexDir, geminiDir, cockpitDir]) mkdirSync(path);

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

// A local bare repository as origin, with main on it, and a finished branch in a worktree of its own: what Ship,
// Release, Tag and Pull work on. Nothing leaves the machine.
const origin = join(base, 'origin.git');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
git('remote', 'add', 'origin', origin);
git('push', '-q', '-u', 'origin', 'main');
git('worktree', 'add', '-q', '-b', 'feature', join(base, 'shop-feature'));
writeFileSync(join(base, 'shop-feature', 'feature.txt'), 'done\n');
execFileSync('git', ['-C', join(base, 'shop-feature'), 'add', '.']);
execFileSync('git', ['-C', join(base, 'shop-feature'), 'commit', '-q', '-m', 'Add the feature']);

// A stand-in for gh, first on the PATH, so the real one (and GitHub) is never reached. It logs every call, and
// answers as if there were no GitHub remote until the suite creates its "online" file; then it knows the
// repository, lists no pull requests or runs except a merged release-0.4.0, and refuses everything else.
const ghDir = join(base, 'gh');
mkdirSync(ghDir);
writeFileSync(
  join(ghDir, 'gh'),
  `#!/bin/sh
dir=$(dirname "$0")
echo "$*" >> "$dir/calls.log"
[ -f "$dir/online" ] || { echo "no git remotes found" >&2; exit 1; }
case "$*" in
  "repo view"*) echo '{"nameWithOwner":"smoke/shop"}' ;;
  "pr list --head release-0.4.0 "*) printf '[{"number":7,"state":"MERGED","url":"https://github.com/smoke/shop/pull/7","mergeCommit":{"oid":"%s"}}]\\n' "$(cat "$dir/merge-sha")" ;;
  "pr list "*|"run list "*) echo '[]' ;;
  *) echo "the smoke test's gh does not answer: $*" >&2; exit 1 ;;
esac
`,
);
chmodSync(join(ghDir, 'gh'), 0o755);

// Harmless agents exercise the real terminal runner and hook CLI; no real agent or provider can be reached.
const agentLog = join(base, 'agent-calls.jsonl');
const fakeAgent = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const nativeId = process.env.COCKPIT_AGENT === 'codex' ? args[1] : 'smoke-native-123';
for (const argv of [['id', nativeId], ['report', 'Smoke agent completed safely.'], ['waiting', 'Smoke permission']]) {
  execFileSync('cockpit', ['session', ...argv], { encoding: 'utf8', stdio: 'pipe' });
}
const file = process.env.COCKPIT_SESSION_FILE;
const record = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.COCKPIT_SMOKE_AGENT_LOG, JSON.stringify({ args, cwd: process.cwd(), provider: process.env.COCKPIT_AGENT, sessionFile: file, managedId: record.id, electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE || null }) + '\\n');
const stop = path.join(path.dirname(process.env.COCKPIT_SMOKE_AGENT_LOG), 'stop-' + record.id);
const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); process.exit(0); } }, 50);
setTimeout(() => { process.stderr.write('Smoke agent was not stopped by the suite.\\n'); process.exit(1); }, 60000).unref();
`;
for (const name of ['smoke-agent', 'codex']) {
  writeFileSync(join(ghDir, name), fakeAgent);
  chmodSync(join(ghDir, name), 0o755);
}
writeFileSync(join(ghDir, 'opencode'), '#!/bin/sh\nprintf "[]\\n"\n');
chmodSync(join(ghDir, 'opencode'), 0o755);
const codexNativeId = '12345678-1234-4123-8123-123456789abc';
const history = join(codexDir, 'sessions', '2026', '11', '16');
mkdirSync(history, { recursive: true });
const now = new Date().toISOString();
writeFileSync(join(history, `rollout-2026-11-16T00-00-00-${codexNativeId}.jsonl`), [
  { type: 'session_meta', timestamp: now, payload: { id: codexNativeId, cwd: workspace, timestamp: now, cli_version: 'smoke', git: { branch: 'main' } } },
  { type: 'event_msg', timestamp: now, payload: { type: 'user_message', message: 'Resume the smoke fixture' } },
  { type: 'event_msg', timestamp: now, payload: { type: 'agent_message', message: 'Saved smoke report.' } },
].map((r) => JSON.stringify(r)).join('\n') + '\n');

let code = 0;
try {
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: suite,
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || undefined,
    // --force-disable-user-env: the extension host keeps this PATH, with the stand-in gh first, instead of the login
    // shell's.
    launchArgs: [
      workspace,
      '--disable-extensions',
      '--skip-welcome',
      '--skip-release-notes',
      '--force-disable-user-env',
      `--user-data-dir=${join(base, 'user-data')}`,
    ],
    extensionTestsEnv: {
      CLAUDE_CONFIG_DIR: claudeDir,
      CODEX_HOME: codexDir,
      GEMINI_CLI_HOME: geminiDir,
      COCKPIT_GEMINI_DIR: geminiDir,
      COCKPIT_HOME: cockpitDir,
      OPENCODE_DATA_HOME: join(base, 'opencode-data'),
      COCKPIT_OPENCODE_COMMAND: join(ghDir, 'opencode'),
      COCKPIT_SMOKE_WORKSPACE: workspace,
      COCKPIT_SMOKE_GH: ghDir,
      COCKPIT_SMOKE_AGENT_LOG: agentLog,
      COCKPIT_SMOKE_CODEX_ID: codexNativeId,
      PATH: `${ghDir}${delimiter}${process.env.PATH ?? ''}`,
    },
  });
} catch (e) {
  console.error('smoke test failed:', e instanceof Error ? e.message : e);
  code = 1;
} finally {
  rmSync(base, { recursive: true, force: true });
}
process.exit(code);
