# Phase 1 verification record

Phase 1 goal: skeleton + connection + checkout/sync loop (character cards and lorebooks), verified on real hosts.

## Automated tests

`cd companion && npm test` — 24 / 24 pass (Node v24.16.0):

| Suite | Tests | Covers |
| --- | --- | --- |
| codec-character | 8 | lossless round-trip, V1 mirrors, CR/BOM preservation, alternate greetings, invalid files |
| codec-lorebook | 9 | lossless round-trip, file naming, new entries (uid + template), front-matter edge cases |
| sync | 7 | end-to-end against a fake tavern: checkout, sync, pull, conflicts, auto-sync, auto-pull |

## TauriTavern (tt) — 2026-10-29, passed

Environment: TauriTavern 2.4.0 (Windows), plugin installed under `<tt data>/extensions/third-party/TavernCellar`,
companion on `127.0.0.1:7349` with an isolated
`CELLAR_HOME`. Driven through WebView2 CDP (`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`).
Test data only: character `TavernCellar_Test`, lorebook `TavernCellar_Test_WI` (both deleted afterwards).

| # | Check | Result |
| --- | --- | --- |
| 1 | Plugin loads; page origin `http://tauri.localhost`, secure context, `crypto.subtle` available | ✅ |
| 2 | WebView connects to `ws://127.0.0.1:7349/link` (Origin + token accepted), handshake ~210 ms | ✅ |
| 3 | `cellar catalog` for characters / lorebooks (summary only, search filter) | ✅ |
| 4 | `cellar checkout` of both items, no round-trip warnings on real tt data | ✅ |
| 5 | Local edit → `cellar sync`: description (CRLF + CJK), added alternate greeting, lorebook entry edit, new entry file | ✅ PNG on disk, V1 mirror, in-memory list and WI cache all updated; new entry got uid 2 + template defaults |
| 6 | Edit in tt's lorebook save path (`saveWorldInfo`) → auto pull into workspace | ✅ |
| 7 | Edit in tt's character editor (debounced form save → `CHARACTER_EDITED`) → auto pull | ✅ |
| 8 | Auto-sync on file save (character, with the editor open) → open editor fields refresh | ✅ |
| 9 | Auto-sync on file save (lorebook) | ✅ |
| 10 | Tavern changed behind the workspace → `sync` refused with `conflict`, tavern copy saved to `.cellar/conflicts/`, `--force` resolves | ✅ |
| 11 | Reconnect after page reload and after companion restart | ✅ |
| 12 | Cleanup: test items deleted, link disabled and token cleared | ✅ |

### Findings fixed during the run

- **tt keeps extra top-level copies** (`creator_notes`, `system_prompt`, `post_history_instructions`).
  Added them to the character codec's mirror list so editing the `.md` file cannot leave a stale copy.
- **Spurious "normalized" warnings after a tt editor save**: tt's editor stores a different `avatar` inside the card,
  while `merge-attributes` always writes the file name back. The host now compares the stored card with the payload it
  actually sent (including `avatar`); the companion adopts the stored data silently unless the host reports real
  normalization. Normalization warnings now list the differing paths.

### Notes

- tt is single-instance: a second launch hands off to the running process, so CDP needs tt fully closed first.
- tt's character cache (file name key, 30 min TTL) is not a problem because `merge-attributes` invalidates it.
- Deleting the character that is currently open makes tt show "current character no longer available" and reload — expected host behaviour.

## TauriTavern (tt) — 2026-10-30, live round 2, passed

Western-fantasy test card `TavernCellar_Test` (scout 艾德里克) bound to lorebook `TavernCellar_Test_WI` (4 entries, one constant),
created through tt's own endpoints. Isolated `CELLAR_HOME` / workspace under `.tmp/`; companion on 7349; tt 2.4.0 driven via CDP 9333.

| Check | Result |
| --- | --- |
| catalog + checkout (character with alternate greetings, lorebook) | pass |
| workspace → tt: description, new `alternate_greetings/03.md`, lorebook entry | pass (in tt API and in-memory list) |
| tt editor → workspace: personality box (form autosave), WI save | pulled automatically within ~3 s |
| same field edited on both sides | `conflict`; workspace kept; tavern copy in `.cellar/conflicts/`; sync/pull refuse without `--force` |
| `sync --force` resolves | pass, tt form shows workspace text |
| auto-sync on, edit files | pushed within ~1 s, no command |
| tt closed → offline | status `offline=True in-sync`; catalog works |
| offline `sync` | PNG / JSON written in data dir; original backed up to `.cellar/backups/<target>/` |
| restart tt | tt shows offline edits; Link reconnects; both items `in-sync` (no false conflict) |

Observed: the first sync after tt saved the card warns `Tavern normalized the saved data: spec, spec_version` once
(tt adds the spec fields); later syncs are clean. Auto-sync does not write offline — offline write-back is explicit.

### Driving tt for tests

- Launch through WMI `Win32_Process.Create` **with the full current environment plus**
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`. `EnvironmentVariables` replaces the whole
  environment; with only the one variable WebView2 starts but never opens the DevTools port.
- `Process.MainWindowHandle` is the hidden single-instance window (`com.tauritavern.client-siw`), not the UI.
- With *close to tray* enabled, WM_CLOSE only hides the window. The graceful-exit event cannot be emitted from the
  page while hidden (`failed to send message to the webview`); use the tray menu *Exit*, or stop the test instance.

## SillyTavern 1.15.0 — pending

ST (`127.0.0.1:8000`) was not running during this session. Same checklist to be run with a temporary browser
profile and `--remote-debugging-port`.
