# Roadmap

## 0.2.1
Status: shipped

- [x] Card ↔ branch link
- [x] Catch up
- [x] Ship
- [x] Release + Tag
- [x] Small fixes: still-open "add as card", lane-first worktree names, Needs you for uncommitted stopped sessions
- [x] Merged-PR sync only inside Pull, so a merge never leaves ROADMAP.md blocking a plain git pull
- [x] Ship dialog names the other board changes that travel with the branch
- [x] Annotated release tags
- [x] Maximize without changing Zen mode's defaults
- [x] Smoke test for Ship, Release, Tag, Pull and Catch up

## 0.2.2
Status: shipped

- [x] Make the panel occupy the whole width when maximized <!-- cockpit:worktree-0.2.2-make-the-panel-occupy-the-whole -->

## 0.3.0
Status: shipped

- [x] Board in .cockpit/ and delivery modes, direct or pr (brief A in /Users/Rafa/RRayes/cockpit/tasks/todo.md)
- [x] The cockpit command a Claude runs: status, ship, release (brief B in /Users/Rafa/RRayes/cockpit/tasks/todo.md)
- [x] UI follows the delivery mode and says why an action is unavailable (brief C in /Users/Rafa/RRayes/cockpit/tasks/todo.md)

## 0.3.1
Status: shipped

- [x] Shipped lanes each show their own tag, not only the newest one

## Backlog

- [ ] First real Ship → merge → Pull → Release → Tag against GitHub (only a fake gh so far)
- [ ] Release bumps package-lock.json along with package.json
