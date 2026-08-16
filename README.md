# NFT/DeFi Agent

A custom agent for EVM NFT marketplaces, built on the [OpenSea API v2](https://docs.opensea.io/reference).
It watches collections for floor-price moves and new low-priced listings,
sends alerts to Discord/email/console, and exposes an order-intake pipeline
that builds **dry-run only** orders — nothing is ever signed or broadcast to
a chain in this version.

> **Note:** this project originally used the Reservoir aggregator API, which
> shut down on 2025-10-15. The data layer was migrated to OpenSea API v2 —
> see [OpenSea API v2](#opensea-api-v2) below. Everything else (Discord bot,
> watchlist filters, dry-run order safety, notifications) is unchanged.

## What it does

- **Monitor**: polls watched collections on an interval for floor price and
  new listings; fires alerts when floor price moves beyond a threshold or a
  new listing appears at or below a target price.
- **Notify**: sends alerts to Discord (webhook) and/or email (SMTP); always
  logs to console. Any channel that isn't configured is skipped gracefully.
- **Orders (dry-run only)**: accepts an order request (buy / list / bid /
  accept-offer), validates it, and computes exactly what would be submitted
  — params, an estimated gas cost, and the endpoint it would hit — without
  signing or sending anything.
- **OpenSea client**: type-safe wrapper for collections/floor/listings/offers,
  with a contract-address → collection-slug resolver since OpenSea keys most
  endpoints off slugs. Runs against the live API when `OPENSEA_API_KEY` is
  set, and transparently falls back to mock data when it isn't, so the whole
  agent is runnable with zero external credentials.
- **Web dashboard**: a local Express server + plain HTML/JS single-page app
  that gives you a watchlist, a live alerts feed, an order form, and a status
  panel — all backed by the exact same monitor/notify/orders modules the CLI
  uses (see [Web dashboard](#web-dashboard) below).
- **Discord bot**: an allowlist-only bid-lead pipeline — a gateway-connected
  bot posts candidate buy opportunities as rich embeds with ✅/❌/👀
  reactions, plus a slash-command interface (`/watchlist`, `/listings`,
  `/floor`, `/offers`, `/watching`, `/whale`, `/config`, `/portfolio`,
  `/status`, `/help`) for managing the allowlist and querying OpenSea on
  demand; only one authorized Discord user can use any of it (see
  [Discord bot](#discord-bot) below).
- **Watch follow-ups**: marking a lead 👀 adds it to a persisted watch set
  that survives restarts and keeps generating alerts — price drop, sold,
  likely delisted (see [Watching items](#watching-items-)).
- **Whale tracking**: mark wallet addresses and get alerted when they buy,
  sell, or list **inside your allowlisted collections** (see
  [Whale tracking](#whale-tracking-)).
- **Charts & daily recap**: the twice-daily trend digest carries a locally
  rendered floor/volume chart, and a once-daily overnight recap summarizes
  the past 24h across every watched collection (see
  [Trend charts and the daily recap](#trend-charts-and-the-daily-recap-)).
- **In-Discord config**: `/config` edits thresholds, quiet hours, mute, rule
  values, and the USD toggle live — validated, persisted, no restart (see
  [In-Discord configuration](#in-discord-configuration-)).
- **Portfolio (read-only)**: resolves an ENS name to its public address and
  reports holdings, floor value, and offers received. Holds no key, signs
  nothing, cannot spend (see [Portfolio](#portfolio-read-only-)).

## Project layout

```
src/
  config/       env loading + zod validation (env.ts), plus runtime.ts — the
                resolution point for tunables editable from both .env and
                /config (watchlist.json overrides .env)
  opensea/      OpenSea API v2 client + address->slug resolver + mock data fallback
  orders/       dry-run order builder, order intake/validation,
                disabled live-execution stub
  monitor/      polls watched collections, detects trends/new listings
  notify/       discord webhook, SMTP email, console — dispatched together
  agent/        orchestrator: wires monitor -> notify, exposes order intake
  dashboard/    Express API server + SSE alert fan-out for the web dashboard
  chart/        dependency-free PNG chart rendering: a minimal PNG encoder
                (png.ts), a tiny software rasterizer with a bitmap font
                (canvas.ts), and the floor/volume chart itself
  eth/          keccak256 + ENS namehash/resolution over read-only eth_call
  portfolio/    READ-ONLY holdings/floor-value/offers for a public address
  watchlist/    allowlist-only bid-lead config (schema/store), filter
                evaluation, quiet-hours/dedupe/rate-limit, the poller that
                turns fresh listings into candidate bid leads, the pure
                add/remove/config mutation logic behind the slash commands,
                and the persisted watch/whale/floor-history stores
  discord-bot/  discord.js gateway client, bid-lead embeds, the ✅/❌/👀
                reaction router, and the slash-command router — all
                unit-testable without a live connection
  index.ts      CLI entry point
public/         static dashboard frontend (index.html, style.css, app.js)
watchlist.example.json
                tracked template for the file below — copy it to start
watchlist.json  allowlist-only bid-lead config + global /config overrides —
                edit this (or use /config) to change what the bot watches.
                GITIGNORED: it holds your real buy triggers (see below)
```

`watchlist.json` is deliberately **not** tracked. It encodes actual target
prices, floor caps, and spread bounds for collections you're really trading —
that's strategy, not shareable config. Start from the template:

```bash
cp watchlist.example.json watchlist.json
```

Both example entries ship with `"enabled": false`, so a fresh copy polls
nothing until you edit it (or add collections from Discord with
`/watchlist add`).

### Local state files (all gitignored)

These are runtime state, written next to `watchlist.json`. Deleting any of
them is safe — each one rebuilds itself, at the cost of re-baselining.

| File | Holds |
| --- | --- |
| `.watchlist-seen-state.json` | Already-seen listing/sale IDs, so a restart never backfills |
| `.watchlist-listing-anchors.json` | #new-listings message/thread anchors per token |
| `.watchlist-watched-items.json` | The 👀 watch set (Group 3.1) |
| `.watchlist-whales.json` | Tracked whale wallets (Group 3.2) |
| `.watchlist-floor-history.json` | Floor/volume time series behind charts + recap (Group 3.3) |
| `.watchlist-highest-offers.json` | Per-collection record-high offer behind #highest-offers |
| `.bot.lock` / `.bot.pid` | Single-instance guard |

## Setup

Requires Node.js 18.17+.

```bash
cd nft-defi-agent
npm install
copy .env.example .env    # Windows; use `cp` on macOS/Linux
```

Edit `.env` as needed — every value is optional. With nothing filled in, the
agent runs entirely on mock data and logs alerts to the console only.

### Getting an OpenSea API key (optional)

See [OpenSea API v2](#opensea-api-v2) below for the two ways to get one (an
instant no-signup key for quick starts, or a permanent one from your OpenSea
account). Put it in `.env` as `OPENSEA_API_KEY=...`.

Without a key, `OpenSeaClient` automatically serves mock collections,
listings, and offers so you can still exercise the monitor, notifications,
watchlist filters, and order intake end-to-end.

### Discord notifications (optional)

Server Settings → Integrations → Webhooks → New Webhook → copy the URL into
`DISCORD_WEBHOOK_URL`.

### Email notifications (optional)

Fill in `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`,
`EMAIL_TO`. For Gmail, use an [app password](https://myaccount.google.com/apppasswords)
rather than your real password.

## Running

```bash
npm run dev              # start the monitor loop (Ctrl+C to stop)
npm run dev -- --once    # run a single poll cycle and exit
npm run dev -- --demo-order   # start, submit one example dry-run bid, print it, exit
```

Production build:

```bash
npm run build
npm start
```

Typecheck only:

```bash
npm run typecheck
```

Unit tests (pure logic + the Discord reaction router with mocked
dependencies — never opens a real gateway connection):

```bash
npm test
```

## Web dashboard

```bash
npm run dashboard
```

Opens a local server at **http://localhost:3000** (configurable via
`DASHBOARD_PORT` in `.env`). It starts the same agent the CLI uses — the
monitor begins polling on `POLL_INTERVAL_SECONDS` immediately — and serves a
single-page dashboard with no build step (plain HTML/CSS/JS in `public/`).

The dashboard is a **view/control surface over the existing engine**, not a
separate implementation — every API route calls straight into the modules
described above:

- **Watchlist** (`GET/POST /api/watchlist`, `DELETE /api/watchlist/:id`) —
  reads `CollectionMonitor.getWatchlistSnapshot()` (cached from the last poll,
  no extra network calls per page load) and calls
  `addCollection`/`removeCollection` on the same monitor instance the poll
  loop uses. Shows floor price and a 24h change figure computed from an
  in-memory price history per collection; until a collection has been
  watched for a full 24h, the change is marked with `*` to show it's measured
  from the oldest sample available rather than a true 24h-ago point.
- **Alerts feed** (`GET /api/alerts`, `GET /api/alerts/stream`) — every alert
  the monitor fires goes through `NftDeFiAgent`'s single alert path: first to
  `dispatchAlert()` (Discord/email/console, unchanged from before), then to
  any registered dashboard listeners. The dashboard listens and rebroadcasts
  the *same* alert objects to connected browsers over Server-Sent Events, so
  the dashboard feed and Discord never disagree about what fired. `GET
  /api/alerts` returns the last 200 for the initial page load; the SSE stream
  (`EventSource` in `public/app.js`) pushes new ones live.
- **Order form** (`POST /api/orders`) — passes the request straight to
  `agent.submitOrder()`, i.e. `src/orders/intake.ts` → `src/orders/dryRun.ts`.
  Same validation, same `DRY_RUN` guard, same dry-run builder as
  `npm run dev -- --demo-order`. The full dry-run result (params, gas
  estimate, and the "NOT called — dry-run only" notice) is rendered as-is —
  the dashboard adds no order logic of its own.
- **Status panel** — `GET /api/status` reports `DRY_RUN`, whether an OpenSea
  key is configured, and which notification channels are enabled. If Discord
  is configured, a "Send Discord test" button calls `POST
  /api/discord/test`, which sends a real test message through the same
  `notifyDiscord()` used for alerts.

## OpenSea API v2

This project's data layer talks to [OpenSea API v2](https://docs.opensea.io/reference)
(`https://api.opensea.io/api/v2`) — the source it migrated to after Reservoir
shut down its public API on 2025-10-15. `src/opensea/client.ts` is the
wrapper; `src/opensea/mockData.ts` is the no-key fallback used everywhere
else in this README as "mock mode."

### Getting a key — two options

**Quick start: instant agent key.** No signup, no auth required:

```bash
curl -X POST https://api.opensea.io/api/v2/auth/keys
```

Returns an `api_key` good for **30 days**, rate-limited to **60 requests/min
for reads** (5/min write, 5/min fulfillment on the free tier) — plenty for
this agent's polling interval. Limited to 2 keys per hour per IP, so don't
regenerate needlessly. Put the returned `api_key` in `.env` as
`OPENSEA_API_KEY`.

**Permanent key**: sign in at [opensea.io](https://opensea.io) → your
profile → **Settings** → **Developer** → create an API key. No expiry, but
you'll need to contact OpenSea directly for higher rate limits if you
outgrow the free tier.

Without a key, `OpenSeaClient` automatically serves mock collections,
listings, and offers — see [Setup](#setup).

### Endpoint mapping

| Capability | Endpoint |
|---|---|
| Collection floor + stats (floor price, 24h volume, owner count) | `GET /collections/{slug}/stats` |
| Recent listings (new-listing detection, bid-lead candidates) | `GET /listings/collection/{slug}/all` |
| Recent offers/bids | `GET /offers/collection/{slug}` |
| Contract address → collection slug | `GET /chain/{chain}/contract/{address}` |
| NFT image + full trait list (per token) | `GET /chain/{chain}/contract/{address}/nfts/{identifier}` |
| Free-text collection search (`/watchlist add` autocomplete) | `GET /search?query=&asset_types=collection` |
| Trending collections (autocomplete fallback for an empty query) | `GET /collections/trending` |
| Collection trait categories + values (trait autocomplete) | `GET /traits/{slug}` |

Auth is a single `X-API-KEY` header; the chain param throughout is
`ethereum` (from `CHAIN_NAME` in `.env`).

### Contract address vs. collection slug

Most OpenSea v2 endpoints key off a collection **slug** (e.g.
`doodles-official`), but everything else in this project —
`watchlist.json`, `WATCHED_COLLECTIONS`, the dashboard — keys off EVM
contract **addresses**, same as before the migration. `OpenSeaClient`'s
private `resolveSlug()` bridges this: it calls `GET
/chain/{chain}/contract/{address}` once per address, caches the result
(slug + a best-effort display name) in memory for the process's lifetime,
and — if a contract doesn't resolve (unlisted, wrong chain, bad address) —
caches that failure too so a bad address isn't re-queried every poll. A
resolution failure (or any other live-call failure) is never papered over
with mock data when a real API key is configured (`OpenSeaClient.request()`
and its callers — see `src/opensea/client.ts`) — the affected collection's
poll tick is skipped and retried next cycle instead.

### Rate limiting & caching

The free/agent OpenSea key is capped around 60 requests/minute, and with
enough watchlist entries the naive "poll everything, every hour" approach
burns through that fast — this was a real, repeatedly-observed problem
(constant `429 Too Many Requests` in the logs) before the fixes below.

- **Central request scheduler** (`src/opensea/requestScheduler.ts`) — every
  single OpenSea call, from every method (`getFloorPrice`,
  `getRecentSales`, slash-command autocomplete, everything), funnels
  through one `RequestScheduler` instance via `OpenSeaClient`'s private
  `request()`. It:
  - **Paces** dispatches against a sliding 60-second window capped at
    `OPENSEA_REQUESTS_PER_MINUTE` (default 50, under the ~60/min cap) —
    anything over budget queues (FIFO) instead of firing and tripping a
    429.
  - **Coalesces** duplicate concurrent requests: two callers wanting the
    exact same URL at the same moment (e.g. two collections' poll ticks
    landing together, or a poll tick overlapping a `/floor` command) share
    one dispatch and one response instead of each spending budget.
  - **Backs off on a 429**: honors the response's `Retry-After` header if
    present (otherwise a short fixed pause) before dispatching anything
    else.
  - **Per-collection poll stagger**: `BidLeadMonitor.pollOnce()` starts
    each collection's poll 1.5s apart rather than firing every collection
    at once, so a fresh poll cycle's burst of calls spreads out instead of
    piling the whole queue up in the same instant.
- **Floor-price cache** — 5-minute TTL, the single highest-value cache
  since floor was previously fetched fresh on every poll tick, trend
  check, `/floor` command, and `/watchlist add` preview. On a live failure
  with a *stale-but-real* cached reading available, that reading is reused
  (same "never fabricate, but don't block on a fresh read" principle as
  the ETH/USD rate) rather than losing the whole poll tick.
- **Already-permanent caches, left as-is** — collection images, NFT
  images/traits, trait catalogs, and slug resolution are cached for the
  process's entire lifetime with no expiry, not a short TTL. This data is
  genuinely static (an NFT's image/traits don't change after minting, a
  contract's collection slug doesn't change), so a permanent cache is
  strictly better for the request budget than adding an expiry that would
  just trigger unnecessary re-fetches for data that was never going to
  change.
- **Health snapshot** — `OpenSeaClient.getRateLimitHealth()` reports
  requests in the last minute, the configured budget, current queue depth,
  and recent-429 count/timestamp.

### What isn't wired up (documented limits)

- **Active listings count** per collection (used by the `liquidity.minListingsCount`
  filter) isn't exposed by `/collections/{slug}/stats`; getting it would mean
  paging through `/listings/collection/{slug}/all` and counting. Left
  undefined against the live API — the filter fails closed (won't match)
  rather than silently passing. See [Watchlist filters](#watchlist-filters).
- **Per-listing rarity rank** isn't included on listing objects from
  `/listings/collection/{slug}/all`, and there's no per-token rank lookup
  wired up — the `rarity` filter (`maxRank`/`maxTopPercentile`) fails closed
  (won't match) against the live API. **Trait metadata**, unlike rank, *is*
  fetched now — a per-token NFT-detail lookup
  (`OpenSeaClient.getNftDetails`, one call per fresh listing, shared with
  the image fetch) populates the token's full trait list, so `traits`/
  `traitFloor` conditions work against live data — see
  [Guided lead rules + traits](#guided-lead-rules--traits).
- **Order building** (`post_offer`/`post_listing`/Seaport fulfillment) is
  dry-run only — see [Dry-run mode](#dry-run-mode-current-safety-posture).

## Discord bot

The Discord bot is a separate, optional layer on top of the existing
webhook alerting (`DISCORD_WEBHOOK_URL` keeps working unchanged). It gives
you an **Accept/Deny/Watch button (or emoji-reaction) command loop** for
candidate buy opportunities ("bid leads") drawn from an **allowlist-only**
watchlist — see [Watchlist filters](#watchlist-filters) below.

### What it does

1. `BidLeadMonitor` (`src/watchlist/leadMonitor.ts`) polls only the
   collections listed in `watchlist.json`, evaluates every fresh listing
   against that entry's filters, and produces a candidate lead when one
   matches.
2. The bot posts a rich embed to `DISCORD_BID_LEADS_CHANNEL_ID` — collection,
   token, trait (if any), price vs. floor (as a friendly "🟢 18% below
   floor" tag), rarity rank, last sale price if the token's sold before,
   quick links (OpenSea item page, Etherscan contract/item/seller), and the
   specific reasons it matched — with an **Accept / Deny / Watch button
   row** attached (✅❌👀 reactions still work too, same underlying action).
3. Only `DISCORD_AUTHORIZED_USER_ID`'s clicks/reactions are ever acted on —
   anyone else's button click gets an ephemeral "not authorized" reply, and
   a stray reaction is logged to `DISCORD_AUDIT_LOG_CHANNEL_ID` and
   otherwise ignored. No exceptions, no other role or permission check
   substitutes for this.
   - **Accept** → first shows an ephemeral **Confirm/Cancel** prompt (only
     the authorized user sees it) — nothing is registered until Confirm is
     clicked. This is the two-step pattern live bidding will reuse later.
     Confirming routes straight into the *existing* dry-run order intake
     (`src/orders/intake.ts` → `src/orders/dryRun.ts`, action `"buy"` at
     the lead's listing price). The full dry-run result (params, gas
     estimate, "NOT submitted — dry-run only") is posted back as a reply in
     the bid-leads channel **and** to `DISCORD_ORDER_LOG_CHANNEL_ID`. This
     never signs or broadcasts anything — same `DRY_RUN` guard, same
     disabled `liveExecution.ts` stub as everywhere else in this project.
   - **Deny** → marks the lead dismissed and logs to
     `DISCORD_AUDIT_LOG_CHANNEL_ID` — no confirm step, registers immediately.
   - **Watch** → adds the token to a watched-subjects set and confirms; if
     that token reappears in a later poll at a different price, the bot
     posts a follow-up note to the bid-leads channel. (This is a best-effort
     signal bounded by the same "recent listings" window the rest of the
     pipeline uses — it's not a dedicated per-token subscription against
     OpenSea.)

   Either way, the card itself updates in place — title gets a
   ✅ ACCEPTED / ❌ DENIED / 👀 WATCHING badge and matching color (denied
   also strikes through the reasoning text), and the button row stays
   visible but disabled, so the channel shows every lead's outcome at a
   glance without needing to scroll to a reply.
4. Two more allowlist-native signals post to their own channels, both
   sourced from the *same* `BidLeadMonitor` poll — never from
   `WATCHED_COLLECTIONS` or any global/trending feed (see the incident note
   below):
   - **New listings** → `DISCORD_NEW_LISTINGS_CHANNEL_ID`, every hourly poll
     (`POLL_INTERVAL_SECONDS`), for listings at or under
     `NEW_LISTING_MAX_PRICE`.
   - **Trend/floor-move digest** → `DISCORD_TREND_ALERTS_CHANNEL_ID`, only
     at the local times in `TREND_ALERT_TIMES` (default `08:00,20:00` —
     twice daily, not on the hourly poll loop at all), comparing the floor
     to the previous scheduled check.
   - **Sales feed** → `DISCORD_SALES_CHANNEL_ID` (`#watchlist-sales`), every
     hourly poll — see [Sales feed](#sales-feed) below.
5. On connect, the bot posts an online/mode/data-source status line to
   `DISCORD_STATUS_CHANNEL_ID`.

If `DISCORD_BOT_TOKEN` isn't set, the bot logs **`Discord bot: token
missing, bot disabled`** and the rest of the agent runs exactly as before —
no gateway connection is ever attempted without a token.

### NFT images + collection-offer intelligence

- **Images.** Bid-lead and new-listing embeds set the Discord embed's main
  `image` to the specific NFT's picture (`OpenSeaClient.getNftImage`, via
  the `/nft/{chain}/{contract}/{identifier}` endpoint's `display_image_url`/
  `image_url`). Trend/floor-move digest embeds are collection-level, so they
  use the collection's icon as a `thumbnail` instead
  (`OpenSeaClient.getCollectionImage`, via `/collections/{slug}`). Both are
  best-effort and cached in-memory for the process lifetime (images rarely
  change) — a lookup failure just omits that part of the embed, it never
  breaks the message. The `/offers` slash command also sets the collection
  icon as its thumbnail.
- **Collection-offer intelligence.** `OpenSeaClient.getCollectionOffers`
  reads OpenSea's criteria-offers endpoint (`/offers/collection/{slug}`) and
  classifies each returned offer's `scope` as `collection`, `trait`, or
  `token` by inspecting its `criteria` field — one read call covers all
  three, rather than three separate endpoint calls.
  - The twice-daily trend digest includes a "Top collection offer: X ETH"
    line (highest currently active `collection`-scoped offer) whenever a
    floor-move alert fires for that collection. It does **not** add a new
    firing condition — the digest still only posts when
    `FLOOR_MOVE_THRESHOLD` is crossed, same cadence as before.
  - The `/offers` command's embed highlights the same top collection offer
    and labels every listed offer's scope (`collection-wide`, `trait ...`,
    `single token`).
  - **Above-market bid leads.** For each token in the current poll's fresh
    new-listings batch (bounded, not swept across the whole collection),
    `OpenSeaClient.getBestOfferForToken` (`/offers/collection/{slug}/nfts/
    {identifier}/best`) is checked against the top collection offer. If it's
    a trait- or token-scoped offer priced at least
    `OFFER_ABOVE_COLLECTION_THRESHOLD_PERCENT` (default 10%) above the top
    collection offer, it's posted to `#bid-leads` as a highlighted lead —
    same ✅/❌/👀 reaction flow, same per-entry dedupe/rate-limit/mute/quiet-
    hours rules as regular leads, but under its own dedupe key
    (`offer:<collection>:<tokenId>`) so it can't suppress, or be suppressed
    by, a regular price-based lead for the same token. This check is
    independent of the entry's normal price/rarity/etc. filters — the offer
    signal being above market is treated as sufficient justification on its
    own.
  - Intentionally not called: `get_collection_offer_aggregates` — the max of
    the already-fetched `getCollectionOffers` list serves the same purpose
    without an extra API call.

### Sales feed

`#watchlist-sales` (`DISCORD_SALES_CHANNEL_ID`) is a bot-only, read-only feed
of completed sales for allowlisted collections — created automatically (in
the **Notifications** category, alongside `#bid-leads`/`#new-listings`/
`#trend-alerts`) and permission-locked by `npm run setup-server`, same as
every other feed channel: `@everyone` denied Send Messages, the bot allowed.

- `OpenSeaClient.getRecentSales` reads `GET /events/collection/{slug}?
  event_type=sale` (`list_events_by_collection`) on the same hourly poll as
  bid leads/new listings — no separate schedule, no extra cadence.
- Each sale embed includes: the NFT image (same `getNftImage` lookup used
  for bid leads), collection name, token id, price (native + a "(~$X)" USD
  estimate — see [USD price estimates](#usd-price-estimates) below for how
  ETH/WETH sales get one and stablecoin sales use their own exact figure
  instead), buyer/seller in short `0x1234…abcd` form, marketplace
  (`opensea`), and age.
- **Dedupe:** a per-collection `seenSaleIds` set (same pattern as
  new-listings) keyed on `` `${transactionHash}:${tokenId}` `` — a tx hash
  alone isn't safe since one transaction can in principle settle more than
  one sale. On top of that, each post also runs through the allowlist
  entry's `LeadLimiter` (same rate-limit/mute/quiet-hours as bid leads),
  under its own `sale:<collection>:<saleId>` dedupe-key namespace so it
  can't collide with bid-lead or above-market-offer dedupe state.
- **Allowlist-only:** sales are only ever fetched for collections in the
  current `this.collections` list (enabled `watchlist.json` entries) —
  the same structural guarantee as every other `BidLeadMonitor` signal.

### USD price estimates

Every ETH-denominated price the bot shows — bid leads (price + floor +
above-collection-offer reasoning), `#new-listings` (new listings, price
changes, and the threaded "Still listed @ X ETH" status), `#watchlist-sales`,
the `#trend-alerts` digest (floor + top collection offer), and the
`/floor`/`/offers`/`/listings`/`/watchlist add` preview embeds — gets a
`0.25 ETH (~$842)`-style USD estimate appended, via one shared helper
(`formatPriceWithUsd` in `src/opensea/client.ts`).

- **Rate source:** OpenSea's own `GET /chain/{chain}/payment_token/{address}`
  (`get_payment_token`), queried for native ETH
  (`0x000...000`), which returns a live `usdPrice`. If that fails, it falls
  back to CoinGecko's public, no-key-required
  `GET /api/v3/simple/price?ids=ethereum&vs_currencies=usd`.
- **Caching:** the rate is cached in memory for **10 minutes**
  (`OpenSeaClient.ETH_USD_CACHE_TTL_MS`) so normal operation makes at most
  one rate call per 10-minute window, not one per message — every price
  formatted in between reuses the cached figure.
- **Never fabricated, never blocking:** if both sources fail and there's no
  prior successful fetch yet, `getEthUsdRate()` returns `undefined` and
  every price simply shows its native amount with no `(~$X)` suffix — no
  guessed or stale-looking number is ever invented. If a live refresh fails
  but an earlier rate is already cached, the last-known rate is reused
  rather than blocking the post. Stablecoin sales (USDC/USDT/DAI) already
  carry their own exact USD figure from OpenSea and are shown as-is
  regardless of the ETH rate.
- **Toggle:** set `SHOW_USD=false` in `.env` to show ETH-only everywhere
  (default `true`). This gates the feature at the source — `getEthUsdRate()`
  itself returns `undefined` — so it cleanly falls through the same
  "no rate available" path as a fetch failure, no per-alert-type flag
  needed.
- **Rounding:** whole dollars at $10+ (`~$842`, `~$3,000`), one decimal
  below that (`~$3.0`) so a sub-floor item doesn't round to a misleading
  whole number. A footer note ("USD is a live estimate, not exact.") is
  added to embeds that show a USD figure, since it moves with the market.

### #new-listings: timestamps, threaded recurrence, flagged price changes

Every listing embed carries a native Discord timestamp (footer clock icon)
via `EmbedContent.timestamp` — set to when the poll observed it, not the
listing's original creation time.

Each distinct order still posts to `#new-listings` exactly once (the
persisted-seen dedupe from the restart-safety fix above already guarantees
that). Beyond that, `BidLeadMonitor` now tracks a per-token "anchor" — which
message currently represents that token's listing, and at what price — via
`src/watchlist/listingAnchorStore.ts` (persisted the same way as
`seenStore.ts`, so it survives restarts):

- **Still listed at the same price** → no new top-level post. Instead, a
  compact `Still listed @ X ETH — <t:...:R>` line is threaded onto the
  original anchor message. The thread is created lazily on the *first*
  recurrence (not proactively on every new listing), and its ID is
  persisted so later recurrences reuse it rather than creating a new thread
  each time. Classification is by **anchor price match, not order-hash
  identity** — see the incident below for why that distinction matters.
- **Token relisted at a different price** → a **flagged** ▲/▼ price-change
  embed (`kind: "price-change"`, warning color) posts fresh at the top
  level, e.g. "▲ Price change — Super Punk World #202" / "relisted at 0.3
  ETH (was 0.2 ETH, ▲ 50.0%)". This becomes the token's new anchor; any old
  thread stays attached to the old (now superseded) message rather than
  being carried over — a new top-level message needs its own thread,
  created lazily the same way on its first recurrence.
- Tokens with **no anchor on record** (e.g. their listing predates this
  feature, or was never posted because it was priced above
  `NEW_LISTING_MAX_PRICE`) are simply not threaded — no crash, no
  backfilled anchor guessed after the fact.

### Incident: relists silently broke threading (fixed)

The original implementation classified a listing as "recurring" purely by
whether its **order hash** had already been seen (`seenListingIds`),
reasoning that a price change necessarily produces a new order hash so
"already-seen order hash" would always mean "unchanged." That reasoning
missed a real OpenSea behavior, confirmed live: a token can be **relisted
at the exact same price under a brand-new order hash** (a renewal, not a
real event) — its old order simply stops being returned and a fresh one
takes its place. Since the new hash had never been seen, it fell into
`newListings` and posted as a plain "New listing" — indistinguishable from
a genuinely new item — silently discarding the existing anchor's thread in
the process. The result: recurrences for anything that got relisted this
way never reached the threading logic at all, even though the code that
threads them (once reached) worked correctly.

Fixed by classifying on **the anchor's recorded price, not order-hash
novelty**: before treating any not-yet-seen order hash as new,
`pollCollection` checks whether the token already has an anchor at the same
price — if so, it's a recurrence (threaded), regardless of whether the
order hash itself changed. Order-hash-based detection (`seenListingIds`)
is kept as a cheap fast path for the common case where the hash genuinely
doesn't change; the anchor-price check is what catches the relist case that
fast path misses. Verified with a deterministic multi-poll test (real
`BidLeadMonitor` + real Discord posting, a fake listing injected with a
new order hash at an unchanged price) that reproduced the exact failure
and confirmed the fix — the recurrence line landed in the thread,
verified by reading it back via the Discord API afterward.

**Threading requires the bot to have `CreatePublicThreads` +
`SendMessagesInThreads`** in `#new-listings` — verified live via
`channel.permissionsFor(botMember)` before implementing this (see git
history / session notes); this bot's role already has both, so threading
is live, not the no-thread fallback. If a future re-invite or permission
change removes it, `postListingRecurrence` in `client.ts` fails closed
(logs a warning, returns `undefined`) — recurrences simply stop being
threaded rather than erroring or falling back to a top-level flood; the fix
is re-granting those two permissions to the bot's role.

### Incident: restart backfill burst (new-listings, bid-leads, sales) (fixed)

`seenListingIds`/`seenSaleIds` are in-memory `Set`s that start empty on
every `BidLeadMonitor` construction. Before this fix, that meant a bot
restart's first poll for a collection found *nothing* in the set, so all ~10
currently-fetched listings/sales looked "new" and got posted — a one-time
burst of pre-existing (not actually new) items to `#new-listings`,
`#bid-leads`, and (once the sales feed shipped) `#watchlist-sales`, on every
single restart. `LeadLimiter`'s in-memory dedupe/rate-limit didn't help here
since it only ever sees items already filtered down to "new" — it can't tell
a genuinely-new listing from a stale one being re-detected after a restart.

Fixed with `src/watchlist/seenStore.ts`: a small JSON file
(`.watchlist-seen-state.json`, gitignored) persisting each collection's
seen listing/sale IDs across restarts.
- On restart, `state.seenListingIds`/`seenSaleIds` are seeded from the
  persisted store instead of starting empty — so a restart only ever
  detects *genuinely* new listings/sales (ones that appeared since the last
  successful poll, persisted or not), never re-treats the same ~10
  currently-fetched items as new.
- A collection with **no persisted entry at all** (a brand-new
  `/watchlist add`, or the very first poll after this fix ships) is treated
  as its true first-ever poll: `newListings` is forced empty (nothing posts
  to `#new-listings`/`#bid-leads`), and `newSales` is limited to sales
  within `SALES_LOOKBACK_MINUTES` (default 30) of "now" rather than the
  full fetched batch — so a fresh start shows a small genuinely-recent
  window instead of dumping full history. Both signal types get baselined
  in the very same poll (`seenStore.recordSeen`), so this only ever happens
  once per collection.
- Collections removed from `watchlist.json` have their persisted state
  dropped (`seenStore.forget`) so a later re-add starts from a clean
  baseline instead of acting on a years-stale seen-set.

### Incident: non-allowlisted collections leaking into #trend-alerts (fixed)

An earlier version wired `CollectionMonitor`'s floor-move/new-listing alerts
(driven by the separate, non-allowlisted `WATCHED_COLLECTIONS`/dashboard
list) directly into `DISCORD_TREND_ALERTS_CHANNEL_ID`/
`DISCORD_NEW_LISTINGS_CHANNEL_ID`. Since that list isn't allowlist-gated,
anything in it — including stale placeholder addresses — could post to
Discord, and a mock-data bug (listing IDs were time-based, so they were
never recognized as "already seen") meant it repeated every poll tick,
producing a flood.

Fixed by removing that wiring entirely: `src/discord-bot/client.ts` no
longer listens to `CollectionMonitor`'s alerts at all. `#new-listings` and
`#trend-alerts` are now populated *only* by `BidLeadMonitor`
(`src/watchlist/leadMonitor.ts`), which — like bid leads — only ever knows
about watchlist.json's enabled entries. This is a structural guarantee, not
a filter: there's no code path left by which a non-allowlisted collection
can reach either channel. (`CollectionMonitor`/`WATCHED_COLLECTIONS` still
exists for the local dashboard only — see [Web dashboard](#web-dashboard) —
and is never wired to Discord in any form.) The mock-data ID bug was also
fixed (`src/opensea/mockData.ts`), and the trend digest additionally moved
off the hourly poll loop onto its own twice-daily schedule (below), so even
a genuine allowlisted collection can't flood the channel from ordinary
price noise.

### Creating the bot (Discord Developer Portal)

1. Go to https://discord.com/developers/applications → **New Application**.
2. **Bot** tab → **Add Bot** → **Reset Token** → copy it into
   `DISCORD_BOT_TOKEN` in `.env`. Treat this like a password — `.env` is
   gitignored, never commit it.
3. Still on the **Bot** tab, no privileged gateway intents are required —
   this bot does not read message content and does not need the
   `MESSAGE CONTENT INTENT` toggle. It only needs the guild/message/reaction
   intents already requested in code (`Guilds`, `GuildMessages`,
   `GuildMessageReactions`).
4. **OAuth2 → URL Generator**:
   - **Scopes**: `bot` **and** `applications.commands` (the second one is
     required for slash commands — see [Slash commands](#slash-commands)
     below; if the bot was invited before slash commands existed, with only
     `bot`, you must re-invite/re-authorize it once for commands to appear)
   - **Bot permissions**: `View Channels` (Read Messages), `Send Messages`,
     `Add Reactions`, `Read Message History`
   - Open the generated URL and invite the bot to your server.
5. Create the channels you want to use (e.g. `#bid-leads`, `#new-listings`,
   `#trend-alerts`, `#order-log`, `#audit-log`, `#status`), enable Developer
   Mode in Discord (User Settings → Advanced), right-click each channel →
   **Copy Channel ID**, and fill in the matching `.env` vars. Leave any
   blank to skip that channel.
6. Right-click your own username → **Copy User ID** → put it in
   `DISCORD_AUTHORIZED_USER_ID`. This is the only account whose ✅/❌/👀
   reactions the bot will ever act on.

### Running it

The bot starts automatically alongside `npm run dev` (default, no flags)
and `npm run dashboard` whenever `DISCORD_BOT_TOKEN` is set — there's no
separate command.

### Slash commands

| Command | What it does |
|---|---|
| `/watchlist add collection:<name\|slug\|address> [trait_category:] [trait_value:]` | Resolves via OpenSea, then shows a **preview** (name/floor/image/owners, plus the trait scope if set) with Confirm/Cancel buttons — nothing is written until you confirm. See [Scoping an add to a trait](#scoping-an-add-to-a-trait). |
| `/watchlist remove collection:<name\|slug\|address>` | Removes the matching entry from `watchlist.json`. |
| `/watchlist list` | Shows every current allowlist entry (name, address, enabled, key filters). |
| `/watchlist create-rule collection: condition: ...` | Guided single-condition lead rule — see [Guided lead rules](#guided-lead-rules--traits) below. |
| `/listings collection:<...> hours:<int>` | Recent listings within the past N hours (default 24). |
| `/floor collection:<...>` | Current floor price and stats. |
| `/offers collection:<...>` | Current top offers/bids. |
| `/status` | Full dashboard: mode, data source, uptime, last poll/trend-check, OpenSea rate-limit health, next trend-digest time, per-collection activity since startup. |
| `/help` | Lists all commands. |

**Authorization**: only `DISCORD_AUTHORIZED_USER_ID` can use any of these —
everyone else gets a private "not authorized" reply and nothing runs, same
guarantee as the ✅/❌/👀 reactions. **All replies are ephemeral** (visible
only to the invoking user) by design, including error messages — this is a
single-operator tool, so command output never needs to be public.

**`/watchlist add` requires confirmation before writing anything**: it
resolves the collection and shows a preview embed (name, slug, address,
floor, owners, 24h volume, thumbnail) with **Confirm add** / **Cancel**
buttons. Only clicking Confirm calls the same
`addWatchlistEntry`/`saveWatchlistConfig`/`BidLeadMonitor.reload()` flow
that used to run immediately — see `src/discord-bot/pendingAdds.ts`
(`PendingAddStore`, in-memory, keyed by a token embedded in the button's
custom ID; resets on restart, so an unconfirmed preview from before a
restart just can't be confirmed — re-run the command). `/watchlist remove`
and `/watchlist create-rule` are unchanged — they still take effect
immediately, no confirmation step (removal is easily undone by re-adding;
create-rule's preview *is* the guided flow itself).

**`/watchlist add|remove|create-rule` take effect immediately once
actioned**: they write to `watchlist.json` on disk and call
`BidLeadMonitor.reload()`, which re-reads the file and applies the diff to
the *running* process — new collections/rules get an immediate poll rather
than waiting up to an hour, removed ones stop being polled — all without
dropping the Discord gateway connection or restarting anything.

**Read-only commands query any resolvable OpenSea collection, not just
allowlisted ones** — `/floor`, `/listings`, and `/offers` are on-demand,
private, authorized-user-only lookups (like using a search engine), not
autonomous posting. That's a different thing from the allowlist-only
guarantee described in the [incident note](#incident-non-allowlisted-collections-leaking-into-trend-alerts-fixed)
above, which is specifically about what the bot posts *unprompted* to
always-on channels. Only `/watchlist add`/`create-rule` can expand what
those channels ever autonomously post about — and even `add` now requires
an explicit button click, not just running the command.

**Collection input resolution** (`src/watchlist/resolveInput.ts` +
`commandRouter.ts`'s `resolveCollectionForCommand`), in order:
1. **An enabled watchlist entry, matched by normalized label** — case/
   spacing/punctuation-insensitive substring match, so typing `super punk
   world` resolves via the watchlist entry labeled "Super Punk World — Nina
   Chanel Abney" even though that's neither the OpenSea slug nor the full
   label.
2. **`OpenSeaClient.resolveCollection`** — a 0x address always resolves via
   `GET /chain/{chain}/contract/{address}`; a slug or name is tried as an
   OpenSea slug directly, then as a naive slugified guess (spaces/
   punctuation → hyphens) — e.g. `Azuki` happens to equal its own slug, but
   `Super Punk World`'s real slug is `nina-super-punk-world`, which no naive
   guess would find.
3. If nothing resolves: a friendly error suggesting `/watchlist list`, plus
   a best-effort "did you mean **X**?" pointing at the closest enabled
   watchlist entry (longest-common-substring scoring), if any is close
   enough to be useful.

**Correction — OpenSea's free-text collection search DOES work** (an
earlier version of this doc claimed it didn't; that was based on an
incomplete test). Verified live: `GET /search?query=&asset_types=collection`
correctly resolves well-known collections by plain display name — "azuki"
→ Azuki, "bored ape" → Bored Ape Yacht Club + Bored Ape Kennel Club,
"pudgy penguins" → Pudgy Penguins. **Coverage is uneven for smaller/
lower-profile collections**, though: searching "super punk world" (this
project's own watchlisted example) returns nothing by display name — only
searching its literal slug text (`nina-super-punk-world`) finds it. So:
- `/watchlist add`'s `collection` autocomplete suggests watchlist entries
  first, then live search results (or trending collections,
  `GET /collections/trending`, when the query is empty) —
  `OpenSeaClient.searchCollections`/`getTrendingCollections` in
  `opensea/client.ts`.
- For a collection that doesn't show up in search (small/new/low-volume),
  type its exact slug or 0x contract address directly — find the slug in
  its OpenSea URL: `opensea.io/collection/<slug>`.

**Autocomplete**: `collection` on every command that takes one; on
`/watchlist create-rule`, `trait_category` and `trait_value` too (see
below). Gated to `DISCORD_AUTHORIZED_USER_ID`, same as actual command
invocation, so it doesn't leak watchlist entry names or live OpenSea data
to other guild members who can technically type a slash command even
though they can't run one.

### Listing ladders and price-change noise

OpenSea's `/listings/collection/{slug}/all` returns **every active order**,
and one token frequently carries many concurrent orders. This is not an edge
case: Super Punk World #327 was observed live with **12 simultaneous
listings** laddered from 0.189512 to 0.189623 ETH.

Two problems fell out of that, both now fixed:

**1. The anchor flip-flop.** The anchor store keys on collection+token, so
feeding it each order in turn made the stored price alternate between rungs
of the ladder, and every alternation posted a "▼/▲ Price change" describing
no real movement. `selectLowestListingPerToken`
(`src/watchlist/lowestListing.ts`) now collapses each tick's listings to
**one per token — the cheapest active order**, which is both the
semantically correct price (it's what you'd actually pay) and structurally
impossible to alternate: there is exactly one price per token per tick.

Posting decisions are consequently driven by *anchor price vs. the token's
cheapest active listing*, not by order-hash novelty:

| Situation | Result |
| --- | --- |
| Anchor matches the cheapest price | Recurrence — thread status updated in place |
| Anchor exists, price moved ≥ threshold | Genuine price change — reposted, anchor advances |
| Anchor exists, price moved < threshold | Recurrence — thread updated, **anchor deliberately held** |
| No anchor, order never seen before | Genuinely new listing — posted |
| No anchor, order seen at baseline | Silent — pre-existing, so restarts never backfill |

**2. Micro-move noise.** Ladder sellers nudge orders by fractions of a
percent — real changes, but ~$0.02 ones. `PRICE_CHANGE_MIN_PERCENT`
(default `1`) is the minimum move required to repost. Sub-threshold drift
updates the thread instead and **does not advance the anchor**, so a slow
genuine slide still reports once it accumulates past the threshold. This
mirrors how `CollectionMonitor` compares against the last *alerted* floor
rather than the last tick, so narrow oscillation can't retrigger forever.

Measured on the live #327 case: 4 alternating posts per tick before, exactly
1 after collapsing, and 0 (thread update only) once the ladder's drift fell
under the threshold — with the anchor stable across consecutive polls.

### Highest offers 💰

`#highest-offers` fires when a watched collection's **top offer sets a new
record high** — not on every offer.

**Records are tracked per scope, not as one blended maximum**, because the
three kinds of offer are not comparable:

| Scope | Means | Image shown | Title |
| --- | --- | --- | --- |
| **Item** | Someone will pay X for **one specific token** | **That item's art** | 🎯 `New highest ITEM offer — <Collection> #<tokenId>` |
| **Trait** | Someone will pay X for **any item with a given trait** ("trait-exclusive") | Collection image | 🏷️ `New highest TRAIT offer — <Collection>` · states `Background = Blue` |
| **Collection** | Someone will pay X for **any item** in the collection | Collection image | 🌐 `New highest COLLECTION offer — <Collection> (any item)` |

Each keeps its **own** high-water mark, and **traits are keyed
individually** — `Background = Blue` and `Fur = Gold` are independent
markets. A single blended max would let one big item offer permanently mask
every collection-wide record (and vice versa); with per-scope tracking, a
0.2 collection-wide record still fires while a 5 ETH item offer stands.
Multiple scopes can therefore post on the same tick, each stating which scope
hit a new high and the delta **vs. that scope's own previous high**.

The embed carries: the scope-appropriate image, the offer amount in **ETH and
USD**, the **scope** (with token id for item offers, `Key = Value` for trait
offers), the **offerer** (short `0x…`, linked to Etherscan), and the delta —
e.g. *"▲ new high 0.21 WETH, up from 0.18 (+16.7%)"*.

Item token ids are best-effort: OpenSea expresses them as
`criteria.encoded_token_ids`, which is only an unambiguous id for a genuine
single-token offer. Multi-token/range criteria leave it undefined, and the
embed then omits the token id and falls back to the collection image rather
than naming one arbitrary token out of a set.

The rules, applied **per scope** in `decideForScope` (pure and unit-tested):

| Situation (within one scope) | Result |
| --- | --- |
| No stored record (first run, or newly added collection) | **Baseline silently** — records the current high, posts nothing |
| Same offer still on top | Nothing — a standing offer must not repost every hour |
| Strictly higher than that scope's stored high | **Post**, and store the new record |
| Equal to the stored high | Nothing — matching isn't beating |
| The record-setting offer is no longer active in that scope | **Re-baseline silently** to the current high |
| Scope has a stored record but no offers this tick | Untouched — nothing to re-baseline to |

That last rule matters: without it, one outlier offer would raise the bar
permanently and the channel would go silent forever once it expired. With it,
the bar follows reality — but it only ever *drops* silently, never as a
notification.

The baseline rule is the same no-backfill posture as listings and sales: a
restart, or adding a collection, never dumps the existing high as though it
just appeared. Records persist in `.watchlist-highest-offers.json`.

Allowlist-only and routed through the same per-entry `LeadLimiter` as every
other signal, under its own `highest-offer:` key namespace so it can't
suppress (or be suppressed by) leads, sales, offers, or whale activity.

It rides the existing hourly poll — no new schedule. The offers read is now
fetched **once per tick and shared** with the above-market-offer check that
already needed it, so the two features cost one call between them rather than
one each. (Previously that read was skipped on ticks with nothing actionable;
now it happens every tick, which is one extra call per collection per hour —
negligible against the request budget, and the honest tradeoff for the
feature.)

Posts to `DISCORD_HIGHEST_OFFERS_CHANNEL_ID` if set, otherwise the
trend-alerts channel.

### Watching items 👀

Marking a bid lead 👀 (the **Watch** button, or the reaction) adds that
token to a **persisted** watch set — `.watchlist-watched-items.json`, via
`src/watchlist/watchStore.ts`. This survives restarts, which is the whole
point: the previous in-memory `Map` silently forgot everything you were
watching every time the process bounced.

Each poll tick, `BidLeadMonitor.checkWatchedSubjects` compares every watched
token against that collection's fresh listings and sales:

| Signal | Detected when | What happens |
| --- | --- | --- |
| **Price change / drop** | Still listed, but at a different price than last recorded | Posts a 📉/📈 update, records the new price, resets the missing-tick counter |
| **Sold** | The token appears in this tick's sales | Posts a 💸 card showing the sale price vs. what you were watching it at, then **stops watching** (nothing left to watch) |
| **Likely delisted** | Absent from both listings *and* sales for 3 consecutive ticks | Posts a 🚪 notice, then stops watching |

Commands:

```
/watching list                                   # everything currently watched
/watching remove collection:<...> token_id:<...> # stop watching one item
```

`/watching list` prints the exact `remove` line for each item, so you can
copy it rather than reconstructing the address by hand.

**Caveat, stated in the alert itself:** "likely delisted" is best-effort.
The listings/sales we poll are capped-size recent-activity windows, not a
full live snapshot, so a quiet collection could in principle miss a tick
without the token actually being delisted. It's a hint, not a fact.

### Whale tracking 🐋

Mark wallet addresses and get alerted when they act **inside your
allowlisted collections**:

```
/whale add address:0xabc… label:punk whale
/whale remove address:0xabc…
/whale list
```

Tracked wallets persist to `.watchlist-whales.json`. Alerts fire on three
actions, all derived from data the poll already has in hand:

| Action | Source |
| --- | --- |
| **BOUGHT** | The wallet is the `buyer` on a sale in this tick |
| **SOLD** | The wallet is the `seller` on a sale in this tick |
| **LISTED** | The wallet is the `seller` on a new listing in this tick |

Three properties worth being explicit about:

- **Strictly allowlist-scoped.** `checkWhaleActivity` is only ever called
  from `pollCollection`, over listings/sales fetched for a collection that
  is on the allowlist *by construction*. A tracked wallet's activity in a
  collection you don't watch is structurally invisible — not filtered out
  after the fact.
- **Zero additional API calls.** It reads the same listings/sales arrays the
  tick already fetched, so turning whale tracking on costs nothing against
  the OpenSea request budget.
- **Deduped and throttled.** Routed through the same per-entry `LeadLimiter`
  as bid leads, under its own `whale:` key namespace so it can never suppress
  (or be suppressed by) a regular lead, sale, or offer for the same token.
  The dedupe key includes the specific event ID, so a genuinely new event
  always gets through while a re-observed one never double-posts. Entry mute
  and quiet hours apply.

Posts to `DISCORD_WHALE_CHANNEL_ID` if set, otherwise the bid-leads channel.

### Trend charts and the daily recap 📊

**Charts.** Every poll tick records the floor/volume reading it already
fetched into `.watchlist-floor-history.json`
(`src/watchlist/historyStore.ts`, ~30 days retained at the default hourly
cadence). The twice-daily trend digest then attaches a floor/volume chart
for the moving collection, and the daily recap attaches up to 5.

Charts are rendered **entirely in-process** by `src/chart/`:

- `png.ts` — a minimal PNG encoder (IHDR/IDAT/IEND + CRC32, compressed with
  Node's built-in `zlib`).
- `canvas.ts` — a small software rasterizer (rects, lines, points, and text
  via an embedded 5×7 bitmap font).
- `floorChart.ts` — the chart itself: floor line colored by net direction,
  volume bars, gridlines, axis labels, and a legend.

Why hand-rolled rather than a chart library: every JS canvas/SVG-rasterizer
option (`canvas`, `sharp`, `resvg`) pulls a **native** binary dependency —
a compile step, platform-specific binaries, and a real chance of a broken
install on Windows. PNG's container format is simple enough that encoding it
directly is smaller and more reliable. It also means nothing about your
watchlist is sent to an external image service. (SVG isn't an option:
Discord doesn't render SVG attachments inline.)

A collection with fewer than 2 samples yields **no chart** rather than a
misleading one-point "trend" — the digest posts text-only instead. Set
`TREND_CHARTS_ENABLED=false` to disable charts entirely.

**Daily recap.** At `DAILY_RECAP_TIME` (default `07:00` local) the bot posts
a 🌅 overnight recap covering the past 24h across *every* watched
collection: top gainer/loser, plus per-collection floor change, new
listings, sales, sale volume, and bid leads. This is deliberately distinct
from the trend digest — the digest reports individual floor *moves* that
crossed a threshold, while the recap summarizes the window whether or not
anything moved.

Recap counters reset each time a recap posts, so consecutive recaps tile the
calendar with no gap or double-counting. A collection without at least two
samples in the window reports its change as `—` rather than a fabricated
`0%`: "not enough history to say" and "it didn't move" are different
statements.

Posts to `DISCORD_RECAP_CHANNEL_ID` if set, otherwise the trend-alerts
channel.

### In-Discord configuration ⚙️

`/config` edits tunables live, with no restart and without dropping the
gateway connection:

```
/config show                                            # every tunable + where its value comes from
/config set key:floor_move_threshold_percent value:8
/config reset key:floor_move_threshold_percent          # fall back to the .env value
/config entry collection:"Super Punk World" key:muted value:true
```

**Global tunables** (`/config set`): `show_usd`,
`floor_move_threshold_percent`, `new_listing_max_price`,
`offer_above_collection_percent`, `trend_alert_times`, `daily_recap_time`.

**Per-collection tunables** (`/config entry`): `muted`, `enabled`,
`target_buy_price`, `max_floor`, `min_percent_from_floor`,
`max_percent_from_floor`, `dedupe_window_minutes`, `rate_limit_per_hour`,
`quiet_hours_start`, `quiet_hours_end`, `quiet_hours_timezone`,
`priority_tier`.

How it works:

- Global overrides live in a `settings` block in `watchlist.json`. Every
  read of a tunable goes through `src/config/runtime.ts`, whose precedence
  is always **watchlist.json override → .env value**. An absent override
  falls straight back to `.env`, so `.env` stays the source of truth for
  anything you haven't deliberately changed from Discord — and
  `/config reset` genuinely restores it.
- Every value is parsed and then validated against the Zod schema
  (`src/watchlist/configMutate.ts`) **before** anything is written, so an
  out-of-range threshold, a malformed `25:00` time, or an unrecognized IANA
  timezone is rejected with a reason rather than corrupting the config.
  The mutation planners are pure and unit-tested.
- Writing triggers the same save-then-reload flow as `/watchlist add`, which
  re-applies overrides process-wide and **reschedules the trend/recap
  timers** if you changed their times.
- Authorized-user-only, like every other command.

### Portfolio (read-only) 📦

`/portfolio` resolves `PORTFOLIO_ENS_NAME` to its public address and reports
holdings grouped by collection, each collection's floor and estimated value,
and a bounded sample of offers received.

The address is **operator-supplied and has no default** — set either
`PORTFOLIO_ENS_NAME=<your-ens-name>` (e.g. `yourname.eth`) or
`PORTFOLIO_ADDRESS=<your-0x-address>` in `.env`. With both blank, `/portfolio`
reports that no portfolio is configured. Nothing personal ships in this repo.

> **This feature is strictly, structurally read-only.** The bot holds **no
> private key or seed phrase** — there is no configuration option to supply
> one. It performs **no wallet connection** and **signs nothing** (no
> `personal_sign`, no `eth_signTypedData`, no transaction signing). It
> **cannot** buy, sell, transfer, list, bid, or approve. It issues only HTTP
> GETs to OpenSea plus read-only `eth_call`s for ENS resolution — neither of
> which can mutate chain state. Observing a public address confers no control
> over it, exactly as with a block explorer.
>
> This is asserted in the code (`src/portfolio/portfolio.ts`,
> `src/eth/ens.ts`), restated in the `/portfolio` embed footer where you
> actually use it, and in the `#server-guide` safety invariants.

Anything that would actually place an order still goes through the existing
dry-run intake (`src/orders/`), itself gated by `DRY_RUN`, with live
execution unimplemented.

**ENS resolution** is done directly rather than via a dependency:
`src/eth/keccak.ts` implements Keccak-256 (Node's `crypto` only offers NIST
SHA3-256 — same permutation, *different padding*, so using it would silently
produce wrong namehashes and resolve to the wrong address), and
`src/eth/ens.ts` does `Registry.resolver(namehash)` → `Resolver.addr(...)`.
Both are verified against published test vectors, including
`namehash("eth")` and the EIP-137 `vitalik.eth` example.

Resolution is cached for the process lifetime and pre-warmed at startup so
`/status` can display the address without blocking. Set `PORTFOLIO_ADDRESS`
to skip ENS entirely. Portfolio lookups need a live `OPENSEA_API_KEY` — with
none configured the bot reports "no holdings" rather than inventing a
portfolio from mock data.

Bounded by design: holdings are capped at 200 items and offers are sampled
on at most 12 tokens (largest holdings first), so `/portfolio` can't blow
the OpenSea request budget. The embed states what was sampled and whether
any collection's floor was unreadable, so a partial figure is never mistaken
for a complete one.

### Scoping an add to a trait

`/watchlist add` takes two optional extras, `trait_category` and
`trait_value`. Supply both and the entry is **scoped to that trait** — only
items carrying it produce leads, new-listing posts, or alerts for that entry:

```
/watchlist add collection:Azuki trait_category:Background trait_value:Blue
```

Mechanically the trait is stored in the entry's `traits` array, which
`evaluate.ts` already enforces (a candidate matches only if its trait set
contains one of them), so this reuses the existing evaluation path rather
than adding a parallel one. Everything else about the add is unchanged: the
usual price-band / bid-spread / liquidity / trend defaults are still applied,
**layered on top of** the trait rather than replaced. The trait narrows
*which items* qualify; the defaults still decide *which of those* are worth
surfacing.

That's the deliberate difference from `/watchlist create-rule`, which builds
a single-condition entry with no implied defaults. Use `add` for "watch this
collection, but only the Blue ones"; use `create-rule` for "alert me on
exactly this one condition".

Details worth knowing:

- **Both halves are required together.** Supplying only a category (or only a
  value) is rejected rather than silently ignored.
- **The trait is validated against the collection's real catalog** before the
  preview appears. A category or value the collection doesn't have is
  rejected, with the valid options listed. Casing is normalized to the
  catalog's, since that's what OpenSea reports on listings — a
  case-mismatched trait would otherwise never match anything.
- **The same collection can be added more than once under different traits**
  (Blue backgrounds and Gold fur as separate entries). Duplicate detection
  keys on collection **+ trait**, so only an identical pairing is refused.
  A collection-wide entry and a trait-scoped one can coexist.
- **Both fields are autocompleted** from the collection's real trait catalog,
  using the same cached-catalog autocomplete as `create-rule` (see below) —
  it resolves whatever is currently in the `collection` field first, so it
  works for a brand-new collection that isn't on the watchlist yet.
- The preview embed and the confirmation message both show the trait scope,
  so you can see what you're about to commit to.

### Guided lead rules + traits

`/watchlist create-rule` builds a **single-condition** allowlist entry —
`src/watchlist/mutate.ts`'s `buildLeadRuleEntry`/`planCreateLeadRule` — and
writes it straight to `watchlist.json` via the same save+reload flow as
`add`/`remove`. Deliberately does **not** layer on `/watchlist add`'s
generic maxFloor/bidSpread/trend defaults: a guided rule represents exactly
the one condition you picked, nothing implied on top of it. A collection
can carry any number of rules (one per condition) — `evaluateCandidate`
tries every enabled entry for a collection in order, same as always.

| `condition` choice | What it sets | Extra required options |
|---|---|---|
| Price below X ETH (`price_below`) | `filters.priceBand.targetBuyPrice` | `price` |
| Top X% rarity (`rarity_top_percent`) | `filters.rarity.maxTopPercentile` | `percentile` |
| Trait = value listed (`trait_listed`) | `traits: [{key, value}]` — item carrying this trait gets listed | `trait_category`, `trait_value` |
| Trait floor (`trait_floor`) | `filters.traitFloor` — this trait, optionally price-capped | `trait_category`, `trait_value`, `price` (optional cap) |

Discord slash commands can't make an option conditionally required based on
another option's value, so all of `price`/`percentile`/`trait_category`/
`trait_value` are optional at the command-definition level;
`validateLeadRuleParams` checks the ones the chosen `condition` actually
needs and returns a clear error if they're missing.

**Trait autocomplete** (`trait_category` then `trait_value`) is driven by
OpenSea's real trait catalog — `GET /traits/{slug}`
(`OpenSeaClient.getCollectionTraits`, cached per collection for the process
lifetime) — not free text. `trait_category` autocomplete needs a
`collection` already picked in the same command invocation;
`trait_value` needs both `collection` and `trait_category` — discord.js
autocomplete interactions expose already-filled sibling option values
(`interaction.options.getString("collection")`, etc.) even before the
command is submitted, so this works within one invocation.

**Live trait data on listings**: `OpenSeaClient.getNftDetails` (a single
cached fetch per token, also used for the image already shown in bid-lead/
new-listing embeds) now returns the token's full trait list from OpenSea's
NFT-detail endpoint, not just image data. `evaluate.ts`'s trait/traitFloor
matching checks this full list (`candidate.traits`) when present, falling
back to the single highlighted `candidate.trait` (what mock data still
populates) otherwise — without this, `trait_listed`/`trait_floor` rules
could only ever match whichever one trait happened to be "highlighted" on
a listing, never any of a token's other traits.

### Registration + re-invite requirement

Slash commands are registered as **guild commands** (instant — no global
propagation delay) on every guild the bot is currently in, right after it
connects. Set `DISCORD_GUILD_ID` in `.env` to pin registration to one guild
instead; leave it blank to register everywhere the bot already is.

**Registering guild commands requires the `applications.commands` OAuth2
scope.** If the bot was invited before this feature existed — with only the
`bot` scope — command registration will fail with a "Missing Access" error
in the logs, and no commands will appear in Discord. Fix it by re-inviting
the bot with both scopes using this URL, substituting your application's
client ID (Developer Portal → your app → General Information → Application
ID):

```
https://discord.com/oauth2/authorize?client_id=<YOUR_BOT_CLIENT_ID>&permissions=68672&scope=bot%20applications.commands
```

Re-authorizing an already-added bot through this URL doesn't remove it or
reset any config — Discord just grants the additional scope. The next time
the bot reconnects (or on its next scheduled restart), registration will
succeed.

### Polling schedule

Two independent cadences, both configured in `.env`:

| Signal | Channel | Cadence | Config |
|---|---|---|---|
| Bid leads | `#bid-leads` | Every poll | `POLL_INTERVAL_SECONDS` (default `3600` — hourly) |
| New listings | `#new-listings` | Every poll | `POLL_INTERVAL_SECONDS` (same poll as bid leads) |
| Trend/floor-move digest | `#trend-alerts` | Twice daily, fixed local times | `TREND_ALERT_TIMES` (default `08:00,20:00`) |

The trend digest is **not** driven by `POLL_INTERVAL_SECONDS` at all — it's
scheduled independently via `setTimeout` to the next occurrence of each
configured local time (recomputed after each firing, so it doesn't drift),
and only compares the floor to the value recorded at the *previous*
scheduled check. That combination — fixed schedule + comparing against the
last check rather than the last poll tick — is what keeps it from firing
more than twice a day even if a price genuinely oscillates across the
`FLOOR_MOVE_THRESHOLD` line repeatedly in between.

`POLL_INTERVAL_SECONDS` also still drives `CollectionMonitor`'s dashboard-only
polling (`WATCHED_COLLECTIONS`) — unrelated to Discord, see the incident
note above.

### Server setup script

```bash
npm run setup-server
```

One-shot, idempotent (`src/scripts/setup-server.ts`): creates any missing
SOP channels (`#server-guide`/`#how-it-works`/`#welcome`/`#butler-commands`/
`#butler-status` under an "Information" category, and `#watchlist-sales`
under a "Notifications" category, if they don't already exist), posts/
updates the pinned channel-SOP and commands-reference embeds, and applies
permission overwrites enforcing "one channel, one job" — @everyone denied
Send Messages on every bot-only channel, the bot explicitly allowed,
`#bid-leads` additionally allowed Add Reactions, `#butler-commands` allowed
Use Application Commands, `#general` left open. Safe to re-run any time —
every step checks existing state first (by channel name, then by message
title among recent messages) rather than blindly creating/posting.

`#butler-status` and `#watchlist-sales` are looked up **by name**, not by
the `.env` ID — so if one gets deleted (intentionally, to clear clutter, or
by accident), re-running this script recreates it under a fresh ID and
**overwrites** the stale `.env` value to match (the one case where this
script clobbers an existing `.env` value on purpose, since that ID is
resolved-by-name automation state, not something you'd hand-set).

Uses discord.js's **REST client only, not a gateway `Client`** — it never
opens a persistent connection, so running it has no effect on the main
bot process's existing session; nothing needs to be restarted afterward.

**Pinning is best-effort.** Discord requires the "Manage Messages"
permission to pin a message, and won't let a bot grant itself a permission
its role doesn't already hold — even with Manage Roles, which only lets you
edit *other* roles' permissions up to what you yourself have. If the Orc
Butler role doesn't have Manage Messages, the script still posts/updates
the SOP and commands-reference content successfully (that's the primary
value) and clearly reports that pinning specifically failed, with the fix:
toggle "Manage Messages" on for the bot's role under Server Settings →
Roles, then re-run the script.

## Running as a background service (Windows)

The bot can run as a durable, always-on Windows background service instead
of a manually-launched terminal process: it auto-starts at logon, auto-
restarts if it ever dies, and survives the launching shell being closed.
This uses **Windows Task Scheduler** — no third-party service manager
(NSSM, pm2, etc.) required.

### How it works

Two scheduled tasks, both created by `scripts/service.ps1`:

| Task | Trigger | Purpose |
|---|---|---|
| `OrcButlerBot` | At logon | Primary launcher. Restart-on-failure: up to 999 retries, every 1 minute. No execution time limit (a scheduled task's default 3-day limit would otherwise silently kill a long-running bot). |
| `OrcButlerBot-Watchdog` | Every 5 minutes, forever | Safety net for the rare case the primary task's own restart-on-failure doesn't catch a death (e.g. it hit its retry cap, or got disabled). Almost always a no-op — see below. |

Both tasks run `wscript.exe scripts\run-hidden.vbs`, a three-line wrapper
whose only job is to start `run-bot.ps1` **without ever painting a window**.

Why it exists: `powershell.exe` is a CONSOLE-subsystem binary, so Windows
allocates and briefly paints a console window *at process creation* — before
PowerShell has run and can honor `-WindowStyle Hidden`. The result is a
console that flashes on screen for a fraction of a second on every launch,
which the 5-minute watchdog turns into a pop-up 288 times a day.
`wscript.exe` is GUI-subsystem and never allocates a console, so launching
PowerShell from it with window style `0` means the console is created
already-hidden and nothing is ever drawn. (`conhost.exe --headless` also
works but is Windows 11+ only; this approach works everywhere.)

The wrapper waits for the bot to exit rather than firing and forgetting, so
the task's lifetime still tracks the bot's — `Stop-ScheduledTask`, the
`State=Running` display, and `MultipleInstances=IgnoreNew` all keep working
— and it propagates node's exit code so restart-on-failure is unaffected.

`run-bot.ps1` itself is unchanged and still:
- Resolves the project root from its own location and sets it as the
  working directory (the app loads `.env` via `dotenv/config`, which
  resolves relative to cwd).
- Rotates `logs/bot-stdout.log` and `logs/bot-stderr.log` to a timestamped
  archive before each run, keeping the last 10 archives per stream.
- Runs the **production build** (`node dist/index.js` — not `tsx watch`)
  in the foreground, so the task's own lifetime tracks the bot's, and
  exits with node's exit code so Task Scheduler's restart-on-failure can
  tell a graceful stop (exit 0 → don't restart) from a crash (non-zero →
  restart it).

**Single-instance guard (critical):** `src/index.ts` writes a PID lockfile
(`.bot.lock`) and checks it on startup — if a live process already holds
it, the new instance logs a line and exits cleanly (code 0) instead of
starting a second Discord connection. This lives in the app itself, not in
the launcher, so it applies no matter how the process is started: the
logon task, the 5-minute watchdog, or a manual `npm run dev` all funnel
through the same check. This is what makes the watchdog safe to run every
5 minutes indefinitely — it's a cheap, instant no-op whenever the bot is
already up. `run-bot.ps1` also checks the same lockfile before touching
any log file, so a concurrent launch never rotates or writes into a log
the live instance still has open.

A stale lock (the process that held it is gone — e.g. it was hard-killed,
which skips Node's normal cleanup) is detected via a PID liveness check
and reclaimed automatically on the next launch.

### Management commands

```
npm run service:install    # Register both scheduled tasks (idempotent — re-run any time)
npm run service:start      # Start the bot now (fires the logon task's action immediately)
npm run service:stop       # Stop it — tells Task Scheduler to end the task (not a raw kill,
                            # so it doesn't trip restart-on-failure), force-kills as a fallback
npm run service:status     # Task state/last-result, whether the bot is actually running, log tail
npm run service:uninstall  # Stop it and remove both scheduled tasks (logs/state files untouched)
```

`npm run service:stop` does **not** remove the scheduled tasks — the bot
will come back at your next logon, or within 5 minutes via the watchdog.
Use `service:uninstall` if you want it to actually stay off.

You can also inspect/manage the tasks directly: `schtasks /query /tn
OrcButlerBot`, or open Task Scheduler (`taskschd.msc`) and look under the
task root — both tasks appear there with their trigger, last run time, and
last result.

### Logs

`logs/bot-stdout.log` and `logs/bot-stderr.log` are the current run;
`logs/bot-stdout-<timestamp>.log` / `bot-stderr-<timestamp>.log` are
rotated archives (last 10 kept per stream, oldest pruned automatically).
Rotation happens on each (re)start, not by a live size cap mid-run — see
`scripts/run-bot.ps1` for the exact mechanics.

### Privilege posture and what this does *not* do

Both tasks run as the current user with **"run only when user is logged
on"** (no password is ever stored, no elevation/admin rights needed to
install). That means:
- The bot starts at **logon**, not at raw system **boot** before anyone
  logs in — a true boot-time, no-login start requires either running the
  task as `SYSTEM` or storing a password for "run whether user is logged
  on or not," both of which this setup deliberately avoids to keep the
  privilege footprint minimal. If you want that, you can register an
  equivalent task yourself with `-RU "SYSTEM"` (no password needed for
  SYSTEM) using `scripts/service.ps1` as a template, or install
  [NSSM](https://nssm.cc/) to wrap `dist/index.js` as a proper Windows
  service.
- **Registering a scheduled task requires a genuine interactive Windows
  session** (Task Scheduler's write API — both the `ScheduledTasks`
  PowerShell module and classic `schtasks.exe` — refuses task creation
  from a non-interactive/automation session with "Access is denied," even
  though read operations like `Get-ScheduledTask`/`schtasks /query` work
  fine there). Run `npm run service:install` from a normal terminal window
  on your own desktop, not from a remote/headless/CI context.

### Install requires an elevated shell, and `Access is denied` (0x80070005)

`npm run service:install` must be run from an **administrator** PowerShell,
from the project directory:

```bash
npm run service:install
```

The script now detects a non-elevated shell and says so up front, instead of
surfacing a raw `Register-ScheduledTask : Access is denied.` CIM exception.

Two things make the registration itself least-privilege, and both matter for
avoiding `0x80070005`:

- **The logon trigger is scoped to your own account.**
  `New-ScheduledTaskTrigger -AtLogOn` *without* `-User` creates an "at log on
  of **any** user" trigger — a machine-wide operation that needs more rights
  than registering a task for yourself. (Symptom to look for: the task's XML
  shows a bare `<LogonTrigger />` with no `<UserId>`.) The trigger is now
  bound to the current user's account.
- **The task is not elevated.** The principal is `LogonType Interactive` /
  `RunLevel Limited` (`InteractiveToken` / `LeastPrivilege` in XML). The bot
  only needs its own project directory and outbound HTTPS, so it never asks
  for admin, and no password is ever stored.

### The watchdog and "incorrectly formatted or out of range" (0x80041318)

A separate failure mode, on the watchdog task specifically:

```
Register-ScheduledTask : The task XML contains a value which is incorrectly
formatted or out of range. (8,42):Duration:P99999999DT23H59M59S
HRESULT 0x80041318
```

`P99999999DT23H59M59S` is `[TimeSpan]::MaxValue`. Passing it as
`-RepetitionDuration` to express "repeat forever" is a common idiom, but Task
Scheduler rejects the value outright.

The correct way to say "indefinitely" is to **omit the duration entirely**:

```powershell
# right — repeats forever
New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)

# wrong — serializes to P99999999DT23H59M59S and is rejected
... -RepetitionDuration ([TimeSpan]::MaxValue)
```

Omitting it leaves `Repetition.Duration` empty, which *is* the indefinite
form. A large finite value like `P3650D` is accepted but isn't truly
indefinite — it silently stops repeating when it elapses. In the raw-XML
fallback the equivalent is a `<Repetition>` block with `<Interval>PT5M</Interval>`
and **no** `<Duration>` element.

If `Register-ScheduledTask` still fails, the script automatically retries via
`schtasks.exe /Create /XML`, which takes a different code path and sometimes
succeeds where the CIM-backed cmdlet does not. Each task is registered
independently and the outcome is reported per task, so a partial install is
handled gracefully — the logon task alone still gives you start-at-logon, and
the watchdog alone still recovers the bot within 5 minutes.

Verify afterwards (read-only, works without elevation):

```bash
schtasks /query /tn OrcButlerBot /v /fo list
```

## Watchlist filters

`watchlist.json` (path configurable via `WATCHLIST_CONFIG_PATH`) is an
**allowlist-only** config, validated against a zod schema
(`src/watchlist/schema.ts`) at load time: a collection — and, if scoped
further, specific token IDs / traits / owner wallets within it — only ever
produces a bid lead if it appears here as an enabled entry, and only once it
passes every filter on that entry. Nothing outside this file is ever
evaluated for bid leads.

The file itself is gitignored — copy `watchlist.example.json` to
`watchlist.json` to start. The template has two entries (both disabled) that
between them exercise every filter type, so it doubles as a format reference:
edit the collection addresses and thresholds to match what you actually want
to watch, then flip `"enabled": true`.

This is separate from the simpler `WATCHED_COLLECTIONS` list used by the
dashboard's floor/new-listing view — that one is not allowlist-gated and
just tracks whatever collections you add via the UI or `.env`.

### Entry shape

```jsonc
{
  "id": "doodles-floor-sweep",       // unique, used for dedupe/rate-limit bookkeeping
  "label": "Doodles blue-chip floor sweep",
  "enabled": true,
  "priorityTier": "blue-chip",        // "blue-chip" | "watch"
  "collection": "0x...",              // required — the allowlist key
  "tokenIds": ["1234"],               // optional — omit to allow any token
  "traits": [{ "key": "Headwear", "value": "Crown" }], // optional trait scope
  "ownerWallets": ["0x..."],          // optional — only leads from these sellers
  "filters": { /* see below */ },
  "quietHours": { "start": "23:00", "end": "07:00", "timezone": "America/New_York" },
  "muted": false,
  "dedupeWindowMinutes": 30,
  "rateLimitPerHour": 6
}
```

### Filter types (all under `filters`, all optional — combine as many as you want)

| Filter | Fields | What it does |
|---|---|---|
| `priceBand` | `minFloor`, `maxFloor`, `targetBuyPrice` | Gates on the collection's current floor and/or the listing's price |
| `rarity` | `maxRank`, `maxTopPercentile` | Rank cutoff or top-N% cutoff. **Fails closed**: if rarity data isn't available (e.g. against the live API — see below), the filter does not match rather than silently passing |
| `traitFloor` | `trait: {key,value}`, `minPrice`, `maxPrice` | Only matches listings carrying that exact trait, within a price range |
| `bidSpread` | `minPercentFromFloor`, `maxPercentFromFloor` | Bounds `((price - floor) / floor) * 100` — negative means below floor (a good buy) |
| `liquidity` | `minVolume24hNative`, `minOwners`, `minListingsCount` | Collection-level liquidity gates |
| `trend` | `minFloorMovePercent`, `minListingSpikeCount` | Fires alongside a floor move and/or a burst of new listings in the same poll tick |
| `walletActivity` | `minWhaleValueNative` | Flags marked-wallet activity above a value threshold (combine with `ownerWallets` to scope to specific wallets) |

Plus, on the entry itself (not under `filters`):

- **Quiet hours** (`quietHours`) — suppresses leads during a daily local-time
  window (wraps past midnight fine, e.g. `23:00`–`07:00`).
- **Per-collection mute** (`muted: true`) — suppresses without deleting the
  entry.
- **Dedupe** (`dedupeWindowMinutes`) — suppresses a repeat lead for the same
  token within this many minutes.
- **Rate limit** (`rateLimitPerHour`) — caps how many leads this entry can
  fire in any rolling 60 minutes.
- **Priority tiers** (`priorityTier: "blue-chip" | "watch"`) — shown on the
  Discord embed so you can visually separate your core watchlist from
  speculative adds.

### Data availability note

In mock mode (no `OPENSEA_API_KEY`), every filter above has representative
mock data to match against — trait, rank/rarity percentile, 24h volume,
owner count, listing count are all populated (see `src/opensea/mockData.ts`).
Against the *live* OpenSea API, some of these fields aren't exposed by the
endpoints this project calls and are left undefined on purpose rather than
faked — see [What isn't wired up](#what-isnt-wired-up-documented-limits) in
the OpenSea API v2 section. Filters gated on missing data fail closed (don't
match) rather than silently passing.

## Dry-run mode (current safety posture)

`DRY_RUN=true` is the default and is enforced in two places:

- `src/orders/intake.ts` refuses any order request when `DRY_RUN` is not
  true (belt-and-suspenders — there's no live path to fall through to yet
  anyway).
- `src/orders/dryRun.ts` is the only implemented order path: it computes the
  full order (action, params, an estimated gas cost) and returns it as data.
  It never constructs a signer, never signs a message/transaction, and never
  calls a broadcast endpoint.

This is the single order path shared by the CLI, the dashboard's order form,
and the Discord bot's ✅ accept handler — all three call
`agent.submitOrder()`, nothing bypasses it.

Example dry-run output (`npm run dev -- --demo-order`):

```json
{
  "dryRun": true,
  "action": "bid",
  "summary": "Place a bid of 1.5 ETH on collection 0x5af0...",
  "params": { "...": "..." },
  "estimatedGasUnits": 110000,
  "estimatedGasCostNative": 0.0022,
  "gasCurrency": "ETH",
  "wouldSubmitTo": "OpenSea POST /offers (post_offer / post_criteria_offer_v2) (NOT called — dry-run only)",
  "timestamp": "2026-01-01T00:00:00.000Z"
}
```

### Where live execution would plug in later

`src/orders/liveExecution.ts` is a disabled stub — calling it always throws.
It documents the four things that must exist before live execution is ever
enabled:

1. `DRY_RUN=false` explicitly set in `.env`.
2. An explicit interactive confirmation from the operator for each specific
   order (price, token, action) before it's submitted.
3. A real signer (e.g. a `viem`/`ethers` wallet backed by a private key or
   hardware signer) — never read from a plain `.env` value.
4. Calling OpenSea's real order endpoints — `POST /offers` (`post_offer` /
   `post_criteria_offer_v2`) for bids, `POST /listings` (`post_listing`) for
   listings — to get signable Seaport order parameters, then signing
   (EIP-712) and, to fulfill an existing listing/offer, broadcasting via
   Seaport contract fulfillment.

None of that exists in this build. There is intentionally no code path that
can sign or send a transaction.

## Environment variables

See `.env.example` for the full list with inline documentation:
`DRY_RUN`, `OPENSEA_API_KEY`, `OPENSEA_BASE_URL`, `CHAIN_ID`,
`CHAIN_NAME`, `RPC_URL`, `WALLET_ADDRESS`, `DISCORD_WEBHOOK_URL`,
`DISCORD_BOT_TOKEN`, `DISCORD_AUTHORIZED_USER_ID`,
`DISCORD_BID_LEADS_CHANNEL_ID`, `DISCORD_NEW_LISTINGS_CHANNEL_ID`,
`DISCORD_TREND_ALERTS_CHANNEL_ID`, `DISCORD_ORDER_LOG_CHANNEL_ID`,
`DISCORD_AUDIT_LOG_CHANNEL_ID`, `DISCORD_STATUS_CHANNEL_ID`,
`DISCORD_SALES_CHANNEL_ID`, `DISCORD_GUILD_ID`,
`SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`,
`EMAIL_FROM`/`EMAIL_TO`, `DASHBOARD_PORT`, `POLL_INTERVAL_SECONDS`,
`WATCHED_COLLECTIONS`, `FLOOR_MOVE_THRESHOLD`, `NEW_LISTING_MAX_PRICE`,
`TREND_ALERT_TIMES`, `OFFER_ABOVE_COLLECTION_THRESHOLD_PERCENT`,
`SALES_LOOKBACK_MINUTES`, `SHOW_USD`, `OPENSEA_REQUESTS_PER_MINUTE`, `WATCHLIST_CONFIG_PATH`.

Added for Group 3: `DISCORD_HIGHEST_OFFERS_CHANNEL_ID`,
`DISCORD_WHALE_CHANNEL_ID`, `DISCORD_RECAP_CHANNEL_ID`,
`DAILY_RECAP_TIME`, `TREND_CHARTS_ENABLED`, `PRICE_CHANGE_MIN_PERCENT`,
`PORTFOLIO_ENS_NAME`, `PORTFOLIO_ADDRESS`, `ETH_RPC_URLS`.

`WATCHED_COLLECTIONS` entries are validated at load: anything that isn't a
well-formed EVM address (`0x` + 40 hex digits) is dropped with a single
one-time warning, rather than being polled and rejected by OpenSea with
`400 Unrecognized address` on every tick. See
[Listing ladders](#listing-ladders-and-price-change-noise) for
`PRICE_CHANGE_MIN_PERCENT`.

Six of these can also be changed live from Discord with `/config set`, which
persists an override into `watchlist.json`; the `.env` value remains the
fallback and `/config reset` restores it. See
[In-Discord configuration](#in-discord-configuration-).

`.env` is gitignored — never commit it. **Never put a private key or seed
phrase in it either**: nothing in this project needs one, and no feature —
including the read-only portfolio view — will ever ask for one.
