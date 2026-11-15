// `.cockpit/` at the top of the main checkout: where Cockpit keeps its own files (the board, its config, the
// requests of the `cockpit` command). Node only, no `vscode`.
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const COCKPIT_DIR = '.cockpit';

/** Makes `<root>/.cockpit/`, with a `.gitignore` that keeps everything in it out of git. The `.gitignore` is
 *  written only when missing: relaxing it (to share the board) is the person's choice, and stays. Returns the folder. */
export async function ensureCockpitDir(root: string): Promise<string> {
  const dir = join(root, COCKPIT_DIR);
  await mkdir(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) await writeFile(ignore, '*\n', { encoding: 'utf8', flag: 'wx' }).catch(() => undefined);
  return dir;
}
