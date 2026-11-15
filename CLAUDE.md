# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working
with code in this repository.

## What this is

Playtime ROI is an Electron desktop app that shows what each Steam game cost
the user per hour played. It runs on the user's own PC; every credential is
typed into the app and saved there. Data is a local SQLite file
(`node:sqlite`, WAL), relocatable in Settings.

## Commands

```bash
npm install
npm run dev         # renderer (Vite :5173) + electron main
npm test            # node:test over src/**/*.test.ts (compiled to dist-test/)
npm run typecheck
npm run build
npm run package     # electron-builder -> release/
```

## Architecture

- `src/shared/` — pure logic, used by both processes and tested directly:
  `licenses.ts` (Steam licenses + package info -> when and how each app came
  in: bought / key / gift / free / family, bundles), `priceHistory.ts` (ITAD
  history -> the price on or before a date), `value.ts` (cost per hour,
  rankings, totals, money formatting). Money is always whole cents.
- `src/main/` — Electron main: `main.ts` (window, IPC, updater),
  `sync.ts` (one sync: Steam sign-in with the saved token -> licenses, Web API
  library + playtime, then price only what is new or changed),
  `steam/steamClient.ts` (`steam-user` behind `SteamUserLike`, so tests drive
  a fake), `steam/webApi.ts` (`GetOwnedGames`), `itad.ts` (IsThereAnyDeal v2),
  `http.ts` (fetch with retry; errors never carry the URL, since keys are
  query parameters), `secrets.ts` (keys and the Steam refresh token,
  encrypted with `safeStorage`), `database/store.ts`, `dbLocation.ts`.
  `testing/fakes.ts` holds the test fakes and is excluded from the shipped
  build (`tsconfig.main.json`).
- `src/renderer/` — React: `Dashboard`, `Library` (sort, search, manual
  price), `Settings` (keys, Steam sign-in, country, theme, database, version),
  `SteamGuardDialog`, `SyncBar`. Talks to main only through
  `window.playtimeRoi` (`preload.ts`); every IPC handler checks the sender is
  the app's own window.

## Rules that are easy to break

- **The Steam folder is read-only** (`src/main/steam/localFiles.ts`, parser in
  `src/shared/vdf.ts`): installs from `appmanifest_*.acf`, collections from
  `userdata/`. Never write to it, never log file contents, and never let a read
  throw out of a sync (a part that can't be read is `null` and keeps its last
  saved value). Games the user has hidden in Steam are left out silently by
  `Store.listGames()`, so every list, total and price lookup skips them; no UI
  text, count or setting may mention them.

- **No credential is ever logged, shown or committed.** Keys are write-only
  in the UI (Saved / Not set). The Steam password is passed to `steam-user`
  once and never stored; only the refresh token is, through `secrets.ts`.
  When `safeStorage` cannot encrypt, nothing is saved (no plain-text
  fallback). Sync progress and results are checked in `sync.test.ts` to
  contain no secret.
- **An expired or refused token is removed** (`SteamAuthError`), but a
  network failure keeps it and syncs the library without new purchase dates.
- **Estimates are estimates.** A manual price beats the estimate; free, gift
  and family games count as zero; keys, bundles and prices recorded after the
  purchase are flagged. Don't present an estimate as what was paid.
- **Prices are looked up once** per game, purchase date and country
  (`needsPricing`); a not-found is retried after 30 days and an error on the
  next sync. Don't re-query ITAD on every sync.
- `src/renderer/themes.css` is vendored from
  [VisualAssault](https://github.com/gerp93/VisualAssault)
  `packages/css/themes.css` at a pinned tag (v0.3.0). Re-run
  `scripts/update-visual-assault-css.sh <tag>` to bump it, never hand-edit.
  Colours in `index.css` come only from the theme's `--color-*` variables.

## Release pipeline

`auto-release.yml` (every push to `main`) and `cut-release.yml` (manual,
explicit version) call KVG_Standards' `release-electron.yml@main` (interim:
KVG_Standards has no tags yet). `ci.yml` typechecks, tests and builds every
PR. To force a release with no code change, add a dated line to
`VERSION_BUMP.md` instead of an empty commit.

## Standards

This repo follows [gerp93/KVG_Standards](https://github.com/gerp93/KVG_Standards)
for theming, release/CI, self-update (`electron-updater`), licensing
(AGPL-3.0), database location, menu (View + Help only), `VERSION_BUMP.md` and
`TODO.md`. See that repo's `README.md` and `REPO_SCOPE.md`; don't assume this
file has the full picture. No logo exists yet (see `TODO.md`).
