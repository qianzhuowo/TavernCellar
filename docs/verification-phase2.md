# Phase 2 verification record（阶段 2：版本管理）

## Automated tests

`cd companion && npm test` — 99 / 99 pass (Node v24.16.0), run several times in a row. New suites:

| Suite | Covers |
| --- | --- |
| vcs | repository created on first open; draft amended in place and dropped when edits are undone; describe / commit / tag; same-length edits within one second are seen (no reliance on the index mtime cache); a user's own git commit is never rewritten; ref names for paths with spaces, dots and CJK |
| history | first open starts the history and points in-sync bindings at it (once — see bug 1); checkout is its own version; record version → sync moves the deployed pointer; syncing an unrecorded draft deploys the draft, and it is shown on the version it became (earlier state only if the content changed since); a tavern edit ends the user's draft first and lands as its own「来自 …」version; diff by slot; restore + sync; unbind drops the pointer |

`studio`: `npm run build` passes.

## SillyTavern 1.15.0 — 2026-11-01, passed

Environment: the user's running ST (left running throughout), a separate browser profile over CDP for checks inside the
page. Companion on `127.0.0.1:7349` with an isolated `CELLAR_HOME`; the workspace `p3st-ws` from the phase-3-prep run,
which had no history yet. Cellar Studio opened in headless Edge. Test data only: `TavernCellar_Test`,
`TavernCellar_Test_WI`.

| # | Check | Result |
| --- | --- | --- |
| 1 | Open the existing phase-1 workspace | ✅ `.git` created, version「开始版本记录」; both in-sync items show「SillyTavern · …」on it |
| 2 | Studio: edit the description → status bar「草稿：1 项未记录」→ history page: write a note,「记录版本」→ sync | ✅ version「阶段2 实机：加一句描述」; ST has the line; the deployed marker moved to it; the inspector shows the version in ST |
| 3 | Edit the personality in ST's own character editor while the workspace has another unrecorded edit → sync | ✅ merged; history shows the user's draft as its own version, then「来自 SillyTavern：合并 characters/TavernCellar_Test」; the diff of that version shows only what ST changed (screenshot `docs/studio/history-dark.png`) |
| 4 | Studio:「把这项恢复成这个版本」on an older version → sync | ✅ workspace back to that version (draft, 1 item unsynced); after sync ST's personality no longer has the ST-editor line and the older scripts / regex are back |
| 5 | CLI: `restore 0ba57aec`, `sync`, `commit`, `tag p2-live`, `log` | ✅ ST back to the merged version (scripts 0, regex 0); `log` shows the tag and the deployed marker on the new version |
| 6 | Field diff of the「来自 SillyTavern」version | ✅ shows top-level `avatar` `TavernCellar_Test.png` → `none` and 角色描述「只有换行符不同」— both are what ST's character form writes on save (CRLF line endings, `avatar: "none"`), recorded faithfully |

Bugs found during the live run and fixed (each has a test):

1. `ready()` returned "just created" on every call, so every status request re-pointed all in-sync bindings at the
   newest version. Found because the deployed marker sat on a version ST did not have. Now a one-shot flag.
2. Recording a version right after syncing an unrecorded draft replaced the deployed commit; the marker disappeared
   from the timeline. It is now shown on the version the draft became, and as「较早状态」only if the content changed.
3. A diff entry with only line-ending changes looked identical on both sides; it is now labelled.

Not verified live:

- TauriTavern. The version code does not touch Cellar Link or the tavern side; tt sync paths are the same as in the
  phase-3-prep run.
- A large lorebook (thousands of entry files): snapshot speed not measured.
- Using git / jj on the workspace at the same time as the companion (covered only by the "user's own commit" test).
