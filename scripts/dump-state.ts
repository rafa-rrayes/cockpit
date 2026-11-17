// Prints the State Cockpit would show for a folder, read with the same adapters and compose() as the extension
// but without VS Code: to check the data layer against reality, and to preview the UI with real data
// (save the output next to dist/dev.html and open dev.html?state=<file>).
//
//   node dist/dump-state.js <workspacePath> [--no-github] [--days <n>] [--compact]
//
// Claude Code's directory is CLAUDE_CONFIG_DIR when set, else ~/.claude. Nothing is written anywhere.
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { compose } from '../src/compose';
import { projectRootOf } from '../src/data/git';
import { defaultClaudeDir, loadAgents, loadGit, loadGithub } from '../src/sources';

const USAGE = 'usage: node dist/dump-state.js <workspacePath> [--no-github] [--days <n>] [--compact]';

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i >= 0) args.splice(i, 1);
    return i >= 0;
  };
  const noGithub = flag('--no-github');
  const compact = flag('--compact');
  let days = 7;
  const d = args.indexOf('--days');
  if (d >= 0) {
    days = Number(args[d + 1]);
    args.splice(d, 2);
    if (!Number.isFinite(days) || days < 0) {
      process.stderr.write(`--days needs a number\n${USAGE}\n`);
      return 2;
    }
  }
  const target = args[0];
  if (!target || args.length > 1 || target.startsWith('-')) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let path: string;
  try {
    path = realpathSync(resolve(target));
  } catch {
    process.stderr.write(`no such folder: ${target}\n`);
    return 2;
  }

  const now = Date.now();
  const [sessions, gitSnap, workspaceProjectKey] = await Promise.all([
    loadAgents(defaultClaudeDir(), days, now, (line) => process.stderr.write(`${line}\n`)),
    loadGit(path, now),
    projectRootOf(path),
  ]);
  const github = !noGithub && gitSnap.git.repoRoot ? await loadGithub(gitSnap.git.repoRoot) : undefined;
  const state = compose({
    now: Date.now(),
    workspace: { name: basename(path), path },
    workspaceProjectKey,
    sessions,
    git: gitSnap.git,
    github,
    releases: gitSnap.releases,
    commits: gitSnap.commits,
  });
  process.stdout.write(`${JSON.stringify(state, null, compact ? undefined : 2)}\n`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    process.exitCode = 1;
  },
);
