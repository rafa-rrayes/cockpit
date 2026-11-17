// A terminal still belongs to its agent. The tiny wrapper records process lifetime for tools without a native
// session adapter, and gives their hooks a vendor-neutral way to report activity through `cockpit session`.
import { join } from 'node:path';

export interface ManagedLaunch {
  command: string;
  args: string[];
  provider: string;
  cwd: string;
  title: string;
  prompt?: string;
  nativeSessionId?: string;
}

export function managedTerminal(command: string, args: string[], meta: Omit<ManagedLaunch, 'command' | 'args'>): { shellPath: string; shellArgs: string[]; env: Record<string, string> } {
  return {
    shellPath: process.execPath,
    shellArgs: [join(__dirname, 'runner.js'), JSON.stringify({ ...meta, command, args })],
    // VS Code's executable is Electron; this runs the packaged helper as Node, without a separate Node install.
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}
