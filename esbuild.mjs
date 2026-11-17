// Bundles: the extension host (node, CommonJS, `vscode` external), the webview (browser, Preact), the browser
// preview (`dist/dev.html` runs the webview against the sample State or a dumped one) and the dump-state script
// (node, no `vscode`: prints the State for a folder, see scripts/dump-state.ts) and the `cockpit` command
// (node, no `vscode`: src/cli.ts, which bin/cockpit runs).
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: ['webview/main.tsx'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'css' } },
  { ...common, entryPoints: ['webview/dev.ts'], outfile: 'dist/dev.js', platform: 'browser', format: 'iife', target: 'es2022' },
  { ...common, entryPoints: ['scripts/dump-state.ts'], outfile: 'dist/dump-state.js', platform: 'node', format: 'cjs', target: 'node20' },
  { ...common, entryPoints: ['src/cli.ts'], outfile: 'dist/cockpit.js', platform: 'node', format: 'cjs', target: 'node20' },
  { ...common, entryPoints: ['src/runner.ts'], outfile: 'dist/runner.js', platform: 'node', format: 'cjs', target: 'node20' },
];

const copyStatic = () => copyFileSync('webview/dev.html', 'dist/dev.html');

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
  copyStatic();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyStatic();
}
