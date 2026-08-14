# SET — real-time multiplayer

A fast, friendly browser game of SET for 2–8 players. One player creates a room,
shares a six-character code or a link, and everyone plays **at the same time** on
their own phone, tablet or computer. There are no turns: all players search the
same shared board simultaneously and race to claim sets.

- **Frontend** — static Vite + TypeScript app, no framework, deployed to GitHub Pages.
- **Backend** — a Cloudflare Worker plus one Durable Object per room, over WebSockets.
- **No accounts, no database, no analytics, no third-party assets.** Cards are
  generated SVG drawn in code; the only font is the device's own system font.

## The rules, briefly

The deck holds exactly 81 cards. Every card is a unique combination of four
features, each with three possible values:

| Feature | Values                  |
| ------- | ----------------------- |
| Number  | one, two, three symbols |
| Shape   | oval, diamond, squiggle |
| Colour  | red, green, purple      |
| Shading | open, striped, solid    |

A **SET** is three cards where, for each of the four features independently, the
values are either all the same or all different. If even one feature has two the
same and one different, it is not a set.

Twelve cards are dealt face up. Everyone searches at once. Claim three cards and
the server checks them: correct scores a point and the cards are replaced; wrong
pauses only you for five seconds and explains which feature clashed. If nobody
can find a set, anyone can press **No SET on board** — the server recomputes the
answer, deals three more cards if the caller was right, and applies the same
five-second pause if they were wrong. The game ends when the deck is empty and no
set remains; final ranking is by number of sets found, and equal scores are a
genuine tie.

## Prerequisites

- **Node.js 20.19+ or 22.12+** (the repo is developed and tested on 22) and npm 10+.
- A free **Cloudflare** account, for deploying the backend.
- A **GitHub** repository with Pages enabled, for deploying the frontend.

Nothing else. No paid services, no API keys, no `.env` file for local
development.

## Install

```bash
npm install
```

This is an npm-workspaces monorepo; one install at the root covers everything.

| Workspace   | Contents                                                               |
| ----------- | ---------------------------------------------------------------------- |
| `shared/`   | Pure SET rules engine, authoritative room state machine, wire protocol |
| `worker/`   | Cloudflare Worker + `GameRoomDO` Durable Object                        |
| `frontend/` | The static game client                                                 |
| `e2e/`      | Playwright multiplayer browser tests                                   |
| `docs/`     | Architecture and protocol notes                                        |

## Run it locally

Two terminals:

```bash
# Terminal 1 — backend on http://127.0.0.1:8787
npm run dev:worker

# Terminal 2 — frontend on http://localhost:5173
npm run dev
```

Open <http://localhost:5173>, create a game, then open the same URL in a second
browser window and join with the code. To play from a phone on the same network,
start the frontend with `npm run dev -- --host` and use the LAN address it
prints. The dev frontend defaults to `http://127.0.0.1:8787` for the backend,
and the Worker always allows `localhost` origins, so neither side needs
configuration.

## Test

| Command                           | What it runs                                                                                                                       |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                        | Rules engine, protocol validators, room state machine, and frontend unit tests.                                                    |
| `npm run test:unit`               | `shared/` only — the rules engine and room state machine.                                                                          |
| `npm run test:frontend`           | Card rendering, selection rules, board layout maths (jsdom).                                                                       |
| `npm run test --workspace worker` | Integration tests against a real `wrangler dev` (workerd) over real WebSockets. Starts and stops it itself.                        |
| `npm run test:e2e`                | Playwright: two browsers in one room, on a phone and a desktop viewport. Starts the Worker and a production frontend build itself. |
| `npm run verify`                  | Format check, lint, typecheck, unit tests, production build.                                                                       |

The end-to-end suite needs a Chromium build once:

```bash
npx playwright install --with-deps chromium
```

Screenshots of every important state are written to `e2e/screenshots/`.

## Build

```bash
npm run build          # -> frontend/dist
```

The build reads two environment variables:

| Variable        | Meaning                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `VITE_BASE`     | Path the site is served from. `/<repo>/` for a GitHub Pages project site; `/` for a root domain. |
| `VITE_API_BASE` | Base URL of the deployed Worker, e.g. `https://set-game-worker.you.workers.dev`.                 |

A production build made without `VITE_API_BASE` will load and then say the game
server is not configured, rather than silently trying to reach localhost.

## Deploy the backend (Cloudflare)

1. Check the allowed origin in `worker/wrangler.toml`. It is pre-filled with the
   GitHub Pages origin for this repository:

   ```toml
   [vars]
   ALLOWED_ORIGINS = "https://eyalbenzvi.github.io"
   ```

   Change it only if you serve the game from another domain. `localhost` and
   `127.0.0.1` are always allowed, so nothing is needed for local development.
   Multiple origins are comma-separated. Any other origin gets a `403` naming
   this variable, so a missed step is obvious rather than mysterious.

2. Deploy:

   ```bash
   npx wrangler login
   npm run deploy --workspace worker
   ```

   Wrangler prints the Worker URL — something like
   `https://set-game-worker.<your-subdomain>.workers.dev`. Keep it for step 2 of
   the frontend deployment.

The Durable Object binding and its migration are already declared in
`worker/wrangler.toml`; `GameRoomDO` uses the SQLite-backed storage class, which
is available on the Cloudflare free plan. There are no secrets to configure.

There is also a manual **Deploy Worker to Cloudflare** GitHub Action if you would
rather not deploy from your machine; it needs a `CLOUDFLARE_API_TOKEN` secret and
a `CLOUDFLARE_ACCOUNT_ID` variable. See
`.github/workflows/deploy-worker.yml`.

## Deploy the frontend (GitHub Pages)

1. In the repository: **Settings → Pages → Build and deployment → Source →
   GitHub Actions**.

2. Add the Worker URL as a repository variable: **Settings → Secrets and
   variables → Actions → Variables → New repository variable**, named
   `SET_API_BASE`, value `https://set-game-worker.<your-subdomain>.workers.dev`.

3. Push to `main`. The **Deploy frontend to GitHub Pages** workflow builds with
   the correct base path (taken from `actions/configure-pages`, so a project site
   at `/<repo>/` and a user site at `/` both work) and publishes `frontend/dist`.

If `SET_API_BASE` is missing, the workflow fails with a message saying so instead
of shipping a broken build.

To deploy by hand instead:

```bash
VITE_BASE=/<repo>/ VITE_API_BASE=https://your-worker-url npm run build
# then publish frontend/dist however you prefer
```

## Where configuration lives

| Setting             | Where                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Backend URL (prod)  | `VITE_API_BASE` at build time (`SET_API_BASE` repo variable)                             |
| Backend URL (dev)   | Defaults to `http://127.0.0.1:8787`; no config needed                                    |
| Backend URL (debug) | `localStorage['set.apiBase']`, if you ever need to point a deployed build somewhere else |
| Pages base path     | `VITE_BASE` at build time                                                                |
| Allowed origins     | `ALLOWED_ORIGINS` in `worker/wrangler.toml`                                              |

## How it works

The Durable Object is the only authority. It owns deck order, board state,
scores, phase, host identity, membership and cooldowns; clients send intents
(`join`, `start`, `claim`, `noSet`, `rematch`, `leave`) and render whatever
authoritative state comes back. Every inbound frame is validated at runtime, not
merely typed. Because a Durable Object is single-threaded and every state
transition is synchronous, simultaneous claims serialise naturally; a
`boardVersion` counter rejects any claim made against a board that has already
changed — and losing that race costs nothing.

All the game logic lives in `shared/`, with no dependency on Cloudflare,
WebSockets, storage or the DOM, which is why the whole multiplayer state machine
can be tested in plain Node.

`docs/ARCHITECTURE.md` covers the layering and the design decisions;
`docs/PROTOCOL.md` documents every message.

## Product decisions worth knowing

- **Selecting a fourth card is refused** with a short prompt, rather than
  silently replacing your earliest pick — on a phone, a mis-tap changing a card
  you thought was locked in is worse.
- **The board is sized to fit the screen.** Column count is chosen by trying every
  option and keeping the one that makes cards largest while still fitting, so all
  face-up cards are visible without scrolling. On a narrow portrait phone that is
  usually four columns for a 12-card board.
- **Reloading rejoins your seat.** A `playerId` + secret token pair is kept in
  `localStorage` per room; presenting it resumes the same seat with the same
  score. The 60-second grace period covers a network blip or a browser reload.
- **Host succession is immediate.** If the host's connection drops, the role moves
  straight to the longest-connected active player, so a lobby is never stuck.
- **No late joining.** Once a game is running, newcomers are told to wait for the
  next one. Spectating was left out rather than shipped half-tested.
- **Duplicate names** get a numeric suffix (`Maya`, `Maya (2)`) so the score strip
  stays readable.
- **Colour is never the only signal.** Every card carries a full text label,
  shapes and shading are distinct, selection is shown with a border, a lift and a
  numbered badge, and an optional switch adds R/G/P letters to each card.
- **English by default**, with every user-facing string in `frontend/src/i18n/en.ts`.
  Adding Hebrew means adding one dictionary and setting `meta.dir` to `rtl`; no
  component contains literal display text, and the shell already applies `dir` to
  `<html>`.

## Known limitations

- **A rematch keeps the same players.** Someone who left cannot be added back
  without creating a new room, because late joining is disabled.
- **A player who drops mid-game does not pause it.** Their seat and score are held
  for 60 seconds, and the remaining players carry on. If everyone but one player
  leaves, the last player can keep playing alone or leave; the game is not ended
  for them automatically.
- **Rooms are ephemeral.** A room with nobody in it is discarded after 30 minutes,
  and seat tokens stored in the browser expire after six hours. Nothing is
  persisted beyond that by design — there is no database.
- **Browser coverage of the automated tests is Chromium only.** The app uses no
  engine-specific APIs and the CSS is standard, but Safari and Firefox have not
  been exercised by the suite; they need a pass of real-device acceptance testing.
- **`ALLOWED_ORIGINS` permits `localhost` unconditionally.** That is a deliberate
  convenience so local development needs no configuration. The API carries no
  credentials and no cookies, so the exposure is a locally-run page being able to
  create rooms on your Worker.
