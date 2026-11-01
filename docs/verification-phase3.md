# Phase 3 prep verification record（阶段 3 前置：拆卡升级与按字段同步）

## Automated tests

`cd companion && npm test` — 85 / 85 pass (Node v24.16.0). The phase-3-prep suites:

| Suite | Covers |
| --- | --- |
| codec-parts | regex / Tavern Helper scripts / variables split into files and back, the three Tavern Helper shapes, order by file number, raw text |
| layout | `layout.exclude` keeps parts in card.json; re-layout keeps the content hash; refused when it would change |
| codec-character-book | embedded `character_book` entries as files |
| codec-lorebook-template | entry front matter omits template-equal fields; snapshot per item |
| merge | slot-level three-way merge; only conflicting slots block |
| sync | older codec items re-laid out at startup without changing hash or sync state |

`studio`: `npm run build` passes.

## TauriTavern (tt) 2.4.0 — 2026-11-01, passed

Environment: tt 2.4.0 (Windows) driven over WebView2 CDP (port 9333); Cellar Link files refreshed in
`<tt data>/extensions/third-party/TavernCellar` before launch (tt closed). Companion on `127.0.0.1:7349` with an
isolated `CELLAR_HOME` and workspace under `.tmp/`. Cellar Studio opened in headless Edge (CDP 9334).
Test data only: character `TavernCellar_Test`, given two regex scripts, two Tavern Helper scripts (one named like the
MVU loader) and variables through tt's own `merge-attributes`.

| # | Check | Result |
| --- | --- | --- |
| 1 | `checkout`: `regex/NN-*.json` + `.replace.txt`, `scripts/NN-*.json` + `.js`, `variables.json`, `character_book/NNNN-*.md`; no round-trip warnings | ✅ |
| 2 | `frameworks` in checkout result and status: 酒馆助手 (2 个脚本), MVU (脚本「MVU 变量更新」) | ✅ |
| 3 | Studio: character header shows the framework line; inspector shows the framework section and「文件拆分」(screenshot `docs/studio/character-parts-dark.png`). Wording later changed to「卡内使用：…」/「卡片使用的脚本框架」so it is not read as TavernCellar's own dependency | ✅ |
| 4 | Studio: untick「角色正则」→ `regex/` removed, scripts in `card.json`, `cellar.json` `layout.exclude: [regex]`, hash unchanged, status `in-sync`; tick again → files back, layout removed | ✅ |
| 5 | Edit split files (replace text, script `.js`, `variables.json`) and swap regex order by renaming `01-` → `03-`; `sync` | ✅ tt API and in-memory list show the edits and the new order |
| 6 | tt changes variables + a regex flag while the workspace changes the description → `sync` | ✅ `merged`; workspace files re-numbered and updated, tt has the description |
| 7 | Same variable changed on both sides → `sync` | ✅ `conflict` on the slot「酒馆助手变量」only |
| 8 | Studio conflict page lists only that slot; 用工作区 → 应用并同步 | ✅ tt holds the workspace value, status `in-sync` |
| 9 | CLI (offline, tt closed, fresh workspace): `checkout --with-world --keep regex,scripts`; `layout` with an unknown part refused; `layout` without `--keep` splits everything | ✅ lorebook checked out with the card; both `in-sync` |

Cleanup: the test scripts and regex were emptied on the test card again (the MVU-like script imports a remote URL).
`merge-attributes` cannot delete keys, so `tavern_helper.variables` keeps three harmless test values.

### Findings fixed during the run

- The CLI could not do what Studio does: added `checkout --with-world` / `--keep` and `cellar layout`.
- The Cellar Link copy installed in tt was older than the repository (warning codes); refreshed before the run.

## SillyTavern 1.15.0 — 2026-11-01, passed

Environment: ST on `127.0.0.1:8000` (basic auth on; the test browser was logged in with the configured credentials,
read in memory only and never written). Cellar Link is this repository itself (ST third-party extension folder).
Isolated companion (`CELLAR_HOME` + workspace under `.tmp/`), ST page in a temporary headless Edge (CDP 9335),
Studio in a second headless Edge (CDP 9334); both profiles deleted afterwards. Same test data and steps as tt.

| # | Check | Result |
| --- | --- | --- |
| 1 | `checkout --with-world`: regex / scripts / variables / `character_book` split; lorebook checked out with the card; no warnings | ✅ |
| 2 | `frameworks`: 酒馆助手 (2 个脚本), MVU | ✅ |
| 3 | Studio header「卡内使用：酒馆助手、MVU 变量框架」; inspector「卡片使用的脚本框架」and「文件拆分」 | ✅ |
| 4 | Studio layout toggle off / on: files move, hash unchanged, `in-sync` | ✅ |
| 5 | Edit split files + reorder by renaming; `sync` | ✅ ST API and in-memory list updated, new order |
| 6 | ST changes variables + regex flag, workspace changes description → `sync` | ✅ `merged` |
| 7 | Same variable on both sides | ✅ conflict on「酒馆助手变量」only; Studio conflict page → 用工作区 → ST holds the workspace value, `in-sync` |

Observed: opening a card that carries regex scripts makes ST ask whether to enable them (「此角色含有内置正则脚本」);
the popup blocks `selectCharacterById` until answered. Answered 「否」 so ST's settings were not changed.
Cleanup as on tt (scripts and regex emptied; three variables remain because `merge-attributes` cannot delete keys).

## Studio S5 polish — ST 1.15.0 + TauriTavern 2.4.0, 2026-11-01, passed

`cd companion && npm test`: 109 / 109 (new suite `assets`: avatar route through `asset.get`, cache + `ETag` / 304,
dropped when the tavern reports an edit of that character, session required, path parts and unknown targets refused;
offline `asset.get` uses the tavern's thumbnail when not older than the card, else the card). Mutation: removing the
cache invalidation on `item.changed` makes the suite fail. `studio`: `npm run build` passes.

Environment: the user's running ST over a temporary headless Edge (CDP 9335); tt started with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9336` after copying only the plugin files
(`index.js`, `manifest.json`, `style.css`, `src/`, `shared/`) into its `extensions/third-party/TavernCellar`;
companion with the isolated `CELLAR_HOME` `p3st-home` and workspace `p3st-ws`; Studio in headless Edge (CDP 9334).

| # | Check | Result |
| --- | --- | --- |
| 1 | `GET /api/assets/avatar` for the test card and three other cards, ST and tt | ✅ 200 `image/png` (ST thumbnails 6–12 KB, tt 28–69 KB), first fetch ≤ 285 ms, revalidation 304 |
| 2 | Studio library, ST and tt | ✅ every visible card shows the tavern's avatar (screenshot not kept: it shows the user's own cards) |
| 3 | Card editor header and sync matrix | ✅ the test card's avatar; lorebook rows keep their initial (`docs/studio/character-avatar-dark.png`) |
| 4 | tt closed, its data folder set as a location, avatars from the offline link | ✅ 200 for two cards, 404 for a missing one; location removed afterwards |
| 5 | Edit the description, `Ctrl+S` | ✅ prompt「已写入工作区。同步到酒馆？」listing SillyTavern (manual sync, local edit);「先不同步」closes it |
| 6 | `Ctrl+S` again,「同步」 | ✅ ST has the new text; then the test text was removed from the workspace and synced back |
| 7 | `Ctrl+P`, type `wi`, Enter | ✅ only `TavernCellar_Test_WI` listed; opens its tab |
| 8 | `Ctrl+F` in the lorebook editor | ✅ focuses the entry search box |
| 9 | Settings → 编辑器: serif, 18 px | ✅ `data-font=serif`, `--fs-editor: 18px`, saved in `config.json` (`docs/studio/settings-editor-dark.png`); restored afterwards |

Not verified live: `Ctrl+Shift+S` with two taverns bound to one item (covered only by the same code path as #6);
「在 VS Code 中打开」(depends on VS Code's URL handler being registered); the desktop build was not repackaged.
