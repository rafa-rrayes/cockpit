// Unit tests only: test/smoke runs inside VS Code (npm run smoke), and .vscode-test holds a downloaded VS Code.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/smoke/**', '.vscode-test/**', 'node_modules/**'],
  },
});
