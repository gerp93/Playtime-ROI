# Playtime ROI

A desktop app that shows what each of your Steam games cost you per hour
played. It reads your Steam library and playtime, the day each game came into
your account, and estimates what the game cost on that day. The dashboard
ranks games from best to worst value, adds up what you spent, and lists the
games you never played.

Everything stays on your computer: a local SQLite file, plus your keys and the
Steam sign-in token saved encrypted with the operating system's own key store
(Electron `safeStorage`). The app syncs when it opens and when you press
**Sync now**; there is no background job.

## What you need

- A **Steam Web API key** (free): https://steamcommunity.com/dev/apikey. It
  reads your library and playtime. Your Steam profile's *Game details* must be
  public for playtime to come back.
- An **IsThereAnyDeal API key** (free): https://isthereanydeal.com/apps/my/.
  It gives each game's Steam price history, used to estimate what you paid.
- Your **Steam sign-in**, once, inside the app (with Steam Guard). Steam's
  license list is the only place that says when each game came into your
  account. The password is used once and never saved; only the sign-in token
  Steam hands back is kept, encrypted. Sign out in Settings removes it.

## How the price is worked out

- A price you type for a game always wins (Library, click the price).
- Free games, gifts and Family Sharing count as nothing paid.
- Otherwise the price is the Steam price IsThereAnyDeal recorded on or just
  before the day the game came in, in your store country. It is marked as an
  estimate, and flagged when it is likely wrong: a key (you may have paid
  less), a bundle (the full single price is used), or a price recorded only
  after you got the game.

## Development

```bash
npm install
npm run dev         # renderer (Vite) + electron main, concurrently
npm test            # unit tests, with fake Steam and IsThereAnyDeal answers
npm run typecheck
npm run build       # build:renderer + build:electron
npm run package     # electron-builder, produces installers in release/
```

A development run keeps its data in a separate `playtime-roi-dev` folder, so
it never touches an installed copy's database.

## Standards

This repo follows [gerp93/KVG_Standards](https://github.com/gerp93/KVG_Standards)
for theming, release/CI, self-update, licensing, database location, release
notes, `VERSION_BUMP.md`, logo/branding, and `TODO.md` conventions. See that
repo's `README.md` and `REPO_SCOPE.md` for the current standards.

## License

AGPL-3.0. See `LICENSE`.
