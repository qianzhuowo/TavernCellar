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

- A large lorebook (thousands of entry files): snapshot speed not measured.
- Using git / jj on the workspace at the same time as the companion (covered only by the "user's own commit" test).

## Pushing versions — ST 1.15.0 + TauriTavern 2.4.0, 2026-11-01, passed

Same isolated companion and workspace; this time both taverns connected at once (ST page in headless Edge, tt
over WebView2 CDP with the current Cellar Link files). `TavernCellar_Test` was bound to tt for the run
(identical after a whole-item resolve with the workspace side) and unbound again afterwards.

`npm test`: 107 / 107 (new suite `push`: 8 tests — push + pin, skipped by sync / auto-sync, tavern edit only noted,
force over it, pull from a pinned tavern merges since the version and follows, follow, error cases, a tag made with
`git tag -a`). Two mutations (drop the pin check in auto-sync; pull tavern edits for pinned bindings) each make the
suite fail.

| # | Check | Result |
| --- | --- | --- |
| 1 | Record a version, tag `p2-release`; keep writing in the workspace (personality line), record again | ✅ |
| 2 | Studio history page: select `p2-release`, choose TauriTavern, 「推送到酒馆」 | ✅ 「TavernCellar_Test 已推送，TauriTavern 固定在 p2-release」; the timeline shows the pinned tt marker on that version (`docs/studio/history-push-dark.png`) |
| 3 | tt has the release, ST has the newer line; `sync --target <tt>` | ✅ refused:「固定在版本 …；先改为跟随最新」 |
| 4 | Edit the card inside tt while pinned | ✅ status「酒馆有修改」, workspace untouched; sync matrix shows「固定在 p2-release，工作区已更新」with「跟随最新」/「取回」(`docs/studio/sync-pinned-dark.png`) |
| 5 | Pull from tt | ✅ `merged`: the tt edit (scenario) came in as「来自 TauriTavern：合并」, the workspace kept its newer personality line, the binding follows again; after syncing, ST and tt both have both edits |
| 6 | Push the release again, then「跟随最新」in the Studio inspector, then sync | ✅ pin gone, status「本地有修改」; after sync tt has the latest content |

Not verified live at that point: pushing several items at once (verified below).

## Pushing several items at once — ST 1.15.0 + TauriTavern 2.4.0, 2026-11-01, passed

Both `TavernCellar_Test` and `TavernCellar_Test_WI` bound to tt for the run (the lorebook differed in five entries
and was made identical with the workspace side), unbound again afterwards.

| # | Check | Result |
| --- | --- | --- |
| 1 | Edit both items (personality line, entry 「银松镇」), record, tag `p2-multi`; edit both again, record | ✅ |
| 2 | Studio history page: select `p2-multi`, TauriTavern,「推送到酒馆」 | ✅ two rows 「已推送，TauriTavern 固定在 p2-multi」; both pinned markers on the version (`docs/studio/history-push-multi-dark.png`) |
| 3 | Read both from tt (lorebook from the backend, not the frontend cache) and from ST after syncing ST | ✅ tt: release lines only for card and entry; ST: release and later lines for both |
| 4 | Edit only the entry inside tt, push `p2-multi` again | ✅ card 「已推送」, lorebook 「酒馆里有新的修改，未推送」 with「去同步页取回」/「覆盖酒馆的修改」; the tt edit is still there (`docs/studio/history-push-partial-dark.png`) |
| 5 |「覆盖酒馆的修改」on that row | ✅ tt entry back to the release; both rows now 「已推送」 |
| 6 | Edit the entry in tt again, pull: the same entry changed on both sides | ✅ conflict on 「银松镇」 only; merged by hand (workspace text + the tt line); after syncing both taverns hold the same card and entry |

Bug found and fixed: retrying one item (「覆盖酒馆的修改」) replaced the whole result list, so the rows of the other
items of that push disappeared. A retry now updates only its own rows.
