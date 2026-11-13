# Cockpit

A VS Code extension that opens in the editor area and shows, live, the project and every Claude Code session on
this machine: which Claudes are busy, idle or waiting for you, their subagents and workflows, the worktrees and
branches, pull requests, CI and releases.

    npm install
    npm run build      # dist/extension.js, dist/webview.js, dist/dev.html
    npm test           # vitest, the data layer
    npm run package    # cockpit-0.1.0.vsix → code --install-extension cockpit-0.1.0.vsix

`src/model.ts` is the contract between the data layer (`src/data/*`, `src/store.ts`) and the UI (`webview/`).
