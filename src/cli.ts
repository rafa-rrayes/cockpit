// `cockpit`, the command a Claude runs in a terminal of a VS Code window with Cockpit (bin/cockpit puts it on the
// terminal's PATH): it asks that window's Cockpit, through the inbox, to do what the board's buttons do, and
// prints the answer. Exit 0: done. 1: refused. 2: no Cockpit, not in a repository, or a usage error.
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { parseArgs, USAGE } from './agent';
import { NoCockpitError, sendRequest } from './inbox';
import { updateManaged } from './data/managed';
import { runManaged } from './runner';

function git(args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'help' || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  // These commands work outside git, without an extension window. All terminal agents can opt in.
  if (argv[0] === 'session') {
    const result = await updateManaged(argv.slice(1));
    (result.ok ? process.stdout : process.stderr).write(`${result.message}\n`);
    return result.ok ? 0 : 1;
  }
  if (argv[0] === 'run') {
    const [provider, separator, command, ...args] = argv.slice(1);
    if (!provider || !/^[a-z][a-z0-9-]{0,63}$/.test(provider) || separator !== '--' || !command) {
      process.stderr.write('Usage: cockpit run <agent> -- <command> [args…]\n');
      return 2;
    }
    return runManaged({ provider, command, args, cwd: process.cwd(), title: `${provider} in ${process.cwd().split(/[/\\]/).pop()}` });
  }
  // The main checkout, from wherever the command runs (a worktree included): that is where Cockpit keeps the inbox.
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) {
    process.stderr.write('cockpit: not in a git repository.\n');
    return 2;
  }
  const root = dirname(common);
  const parsed = parseArgs(argv, git(['symbolic-ref', '--quiet', '--short', 'HEAD']));
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  try {
    const result = await sendRequest(root, parsed.action, {
      onWaiting: () => process.stderr.write('cockpit: waiting for Cockpit (it may be asking you something in VS Code)…\n'),
    });
    for (const line of result.lines) process.stdout.write(`${line}\n`);
    return result.ok ? 0 : 1;
  } catch (e) {
    process.stderr.write(`cockpit: ${e instanceof Error ? e.message : String(e)}\n`);
    return e instanceof NoCockpitError ? 2 : 1;
  }
}

void main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (e: unknown) => {
  process.stderr.write(`cockpit: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
