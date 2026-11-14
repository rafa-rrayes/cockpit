// The folders other VS Code windows have open, so "Clean merged" never removes a worktree that another window
// shows. Each window's Cockpit writes its folders to <dir>/<extension host pid>.json (dir sits in globalStorage,
// which every window of a profile shares) and removes the file when it closes. A file whose process is gone (a
// crash) is skipped and deleted; one whose pid was reused only keeps a few more worktrees, which is the safe side.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class WindowRegistry {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly pid = process.pid,
    private readonly isAlive: (pid: number) => boolean = pidAlive,
  ) {
    this.file = join(dir, `${pid}.json`);
  }

  /** Records this window's folders (again after they change). */
  publish(folders: string[]): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify({ pid: this.pid, folders }));
    } catch {
      // Without the record other windows only miss this one's folders; nothing here depends on it.
    }
  }

  /** The folders of the other windows still open. */
  otherFolders(): string[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const name of names) {
      const pid = Number(/^(\d+)\.json$/.exec(name)?.[1]);
      if (!Number.isInteger(pid) || pid === this.pid) continue;
      const path = join(this.dir, name);
      if (!this.isAlive(pid)) {
        rmSync(path, { force: true });
        continue;
      }
      try {
        const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
        const folders = typeof v === 'object' && v !== null ? (v as { folders?: unknown }).folders : undefined;
        if (Array.isArray(folders)) out.push(...folders.filter((f): f is string => typeof f === 'string'));
      } catch {
        // Half-written or foreign: skip it.
      }
    }
    return out;
  }

  dispose(): void {
    rmSync(this.file, { force: true });
  }
}
