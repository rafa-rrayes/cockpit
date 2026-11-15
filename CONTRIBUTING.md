# Contributing to Cockpit

Thanks for taking a look! Issues and pull requests are welcome.

## Setup

    npm install
    npm run build       # dist/extension.js, dist/webview.{js,css}, dist/dev.html, …
    npm run typecheck   # extension host and webview
    npm test            # vitest

Press F5 in VS Code to run the extension in an Extension Development Host, or open `dist/dev.html` in a browser to
work on the UI against the built-in sample data (see [Development](README.md#development) for previewing real data).

`npm run smoke` starts a real VS Code with the extension and walks through Ship, Release, Tag, Pull and Catch up.

## Pull requests

- Keep a change small and focused; one feature or fix per pull request.
- Add or update tests for the data layer (`src/data/*`, `src/compose.ts`, `src/catchup.ts`, `src/publish.ts` are
  pure and easy to test).
- Add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md) for anything a user would notice.
- `npm run typecheck` and `npm test` must pass; CI runs both.

## Privacy

Cockpit reads Claude Code transcripts, which can contain anything. Never commit a dumped `state.json` or a
screenshot of real sessions; use the sample State in `webview/sample-state.ts` instead.
