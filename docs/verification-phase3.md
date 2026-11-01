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
| 3 | Studio: character header shows「需要 酒馆助手、MVU 变量框架」; inspector shows「依赖的脚本框架」and「文件拆分」(screenshot `docs/studio/character-parts-dark.png`) | ✅ |
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

## SillyTavern 1.15.0 — pending

ST was not running during this session. Same checklist to be run with a temporary browser profile and
`--remote-debugging-port`.
