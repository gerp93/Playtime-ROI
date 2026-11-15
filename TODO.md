# TODO

This app's own backlog of future features and fixes — not a KVG_Standards
compliance checklist (see [KVG_Standards](https://github.com/gerp93/KVG_Standards)
and its `REPO_SCOPE.md` for that). Just what's not built yet.

## Check against the real services

- Sign in to Steam with a real account (password, Steam Guard by email and by
  the mobile app, then a sync with the saved token). Only tested against a
  fake `steam-user`.
- IsThereAnyDeal: the lookup (`POST /lookup/id/shop/61/v1`) and price history
  (`GET /games/history/v2`) calls are written from ITAD's v2 docs and never
  run with a real key. Check the answer shapes in `src/shared/priceHistory.ts`.
- Steam Web API `GetOwnedGames` with a real key and a public profile.
- License `time_created` as the purchase date, and the license kinds
  (key, gift, free, family) on a real account.
- Purchase history on a real account: the web session from `steam-user`
  (`webSession` cookies) and the "Load More Transactions" call
  (`POST /account/AjaxLoadMoreHistory/`, cursor fields as the page's script
  holds them). The row parser is checked against a saved page; the paging and
  cookies are only tested against fakes.

## Features

- Purchase history: show which receipt a game's price came from, and let the
  user fix a wrong name match by hand.
- Split an ITAD-estimated bundle's price across its games instead of using
  each game's full single price (receipt prices are already split).
- More than one currency in the totals (today games priced in another
  currency are listed but left out of the total).

## Fixes

- `safeStorage.isEncryptionAvailable` is deprecated in newer Electron in
  favour of `isAsyncEncryptionAvailable`; move `src/main/secrets.ts` over.
- The `overrides` in `package.json` (protobufjs for steam-appticket, adm-zip)
  clear npm audit warnings from steam-user's dependencies; drop them once
  steam-user ships fixed versions.

## Branding

- No `assets/logo.png` source mark yet, so `scripts/generate-icons.js` is
  wired but inert and the window has no icon. A placeholder mark is worse than
  none (KVG_Standards "Logo & branding").
