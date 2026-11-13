// Two bundles: the extension host (node, CommonJS, `vscode` external) and the webview (browser, Preact).
// `dist/dev.html` runs the webview in a plain browser against the sample State, for screenshots and UI work.
import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });

const common = { bundle: true, sourcemap: true, logLevel: 'info' };
const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'] },
  { ...common, entryPoints: ['webview/main.tsx'], outfile: 'dist/webview.js', platform: 'browser', format: 'iife', target: 'es2022', jsx: 'automatic', jsxImportSource: 'preact', loader: { '.css': 'css' } },
  { ...common, entryPoints: ['webview/dev.ts'], outfile: 'dist/dev.js', platform: 'browser', format: 'iife', target: 'es2022' },
];

const copyStatic = () => copyFileSync('webview/dev.html', 'dist/dev.html');

if (watch) {
  for (const b of builds) (await esbuild.context(b)).watch();
  copyStatic();
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
  copyStatic();
}
