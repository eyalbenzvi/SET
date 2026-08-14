# Architecture

## Shape of the system

```
   Browser (phone / tablet / desktop)                    Cloudflare
 ┌───────────────────────────────────┐        ┌──────────────────────────────────┐
 │  Static frontend (GitHub Pages)   │  HTTP  │  Worker  (worker/src/index.ts)   │
 │  Vite + TypeScript, no framework  │ ─────► │  • origin allow-list / CORS      │
 │                                   │        │  • mints room codes              │
 │  • renders authoritative state    │        │  • routes to the right room      │
 │  • sends intents only             │        └───────────────┬──────────────────┘
 │  • owns nothing but its selection │                        │ one instance per room
 │                                   │   WebSocket            ▼
 │                                   │ ◄────────► ┌──────────────────────────────┐
 └───────────────────────────────────┘            │ GameRoomDO (Durable Object)  │
                                                  │  • WebSocket fan-out         │
                                                  │  • storage + alarms          │
                                                  │  • rate limiting             │
                                                  │        wraps ↓               │
                                                  │  GameRoom (pure engine)      │
                                                  │  deck, board, scores, phase, │
                                                  │  host, membership, cooldowns │
                                                  └──────────────────────────────┘
```

## The layering decision that matters most

All game logic lives in `shared/src/`, and none of it knows that Cloudflare
exists:

| Module        | Responsibility                                               |
| ------------- | ------------------------------------------------------------ |
| `cards.ts`    | The 81-card deck. Attributes encoded as `0 \| 1 \| 2`.       |
| `rules.ts`    | `isSet`, `findAllSets`, `findRequiredThirdCard`, mismatches. |
| `shuffle.ts`  | Fisher–Yates over an injectable random source.               |
| `room.ts`     | `GameRoom` — the authoritative state machine.                |
| `protocol.ts` | Wire types **and** the runtime validator for inbound frames. |

`GameRoom` takes commands (`join`, `start`, `claim`, `noSet`, `rematch`,
`leave`, `tick`) and returns a list of messages to deliver, each addressed to
either everyone or one player. It reads the clock and randomness through an
injected `RoomEnv`, so tests drive it with a fake clock and a seeded shuffle.

`GameRoomDO` (in `worker/src/room-do.ts`) is the only place that touches
WebSockets, storage and alarms. It parses frames, enforces the per-socket rate
limit, maps seats to sockets, and hands everything else to `GameRoom`.

The payoff: the rules and the entire multiplayer state machine are testable in
plain Node with no emulator, which is why the unit suite can simulate 60
complete games and assert invariants after every single action.

## Why the server is the only authority

Clients send intent, never facts. A claim says "these three card ids, at board
revision N" — the server decides everything else. Concretely, the client never
computes a score, never removes a card, never decides validity, and never learns
the deck order or where a set is.

Serialisation comes free: a Durable Object is single-threaded and every
`GameRoom` method is synchronous, so two players cannot interleave mid-claim.
The `boardVersion` counter closes the remaining gap — a claim made against a
board that has already changed is rejected as `board_changed` rather than
applied to a different board.

## Deliberate design choices

**A stale claim is never punished.** The check order in `GameRoom.claim` is
cooldown → board version → validity. Losing a race is not a mistake, so it costs
nothing; only a genuinely wrong claim starts the 5-second cooldown.

**Replacement cards keep their slots.** When the board is at 12 and the deck has
cards, the three replacements go into the vacated positions. Cards the player was
already looking at do not move. Above 12 cards nothing is dealt and the board
shrinks, per the standard rules.

**Seat tokens, not sessions.** Joining mints a `playerId` plus a secret `token`
(128 bits each). The token is stored in `localStorage` per room code and
presented to resume a seat. It is what stops one client claiming another's score,
and it means a reload puts a player straight back into their own seat. No
accounts, no cookies, no third-party auth.

**Host succession on disconnect, not after the grace period.** The moment the
host's socket drops, the role moves to the longest-connected active player, so a
lobby is never stuck waiting on someone who has walked away. The original host
does not get the role back on reconnect.

**No late joining.** Once a game is playing, a new player is told the game has
started. Spectating was considered and left out rather than shipped half-tested.

**The board is sized to fit, not laid out on breakpoints.** `frontend/src/ui/grid.ts`
tries every column count from 2 to 6, computes how large a card could be in each,
and picks the best — because scanning a SET board requires seeing all of it at
once. A consequence: a narrow portrait phone usually lands on four columns for a
12-card board, since that both fits and yields larger cards than three would.

**The activity feed lives in the header.** Floating toasts over a 360px board
cover cards. During play, events appear as a single line in the header instead;
toasts are only used on the lobby and results screens.

## Game lifecycle

```
        ┌────────┐  host starts (≥2 connected)   ┌─────────┐
        │ lobby  │ ────────────────────────────► │ playing │
        └────────┘                               └────┬────┘
             ▲                                        │ deck empty and
             │                                        │ no set on board
             │        host starts rematch         ┌────▼─────┐
             └────────────────────────────────────│ finished │
                                                  └──────────┘
```

A game ends the moment the deck is empty and the board contains no valid SET —
either detected right after an accepted claim, or when a correct "No SET on
board" call finds nothing left to deal.

The position "no set on the board, cards still in the deck" is always
resolvable: any player may call "No SET on board", the server recomputes the
answer from the authoritative board, and deals three more cards if the caller was
right. A wrong call costs that caller a cooldown and reveals nothing.

## Storage and lifetime

The room is persisted to Durable Object storage after every mutation, so an
eviction mid-game does not lose the board. A restored room starts with every
player marked disconnected and inside their reconnect grace window.

An alarm handles the two time-based transitions: reclaiming a seat after the
60-second grace period, and discarding a room that has been empty for 30
minutes.

## Testing strategy

| Layer                   | Where                          | What it proves                                                                         |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------- |
| Rules engine            | `shared/test/rules.test.ts`    | Deck correctness; exhaustive check of all 6,480 card pairs; all 1,080 sets found once. |
| Protocol validators     | `shared/test/protocol.test.ts` | Malformed, oversized, hostile and out-of-range frames are refused.                     |
| Room state machine      | `shared/test/room.test.ts`     | Scoring, replacement, cooldowns, host transfer, reconnect, 60 full simulated games.    |
| Worker + Durable Object | `worker/test/`                 | Real workerd, real WebSockets: auth, fan-out, races, rate limits, CORS.                |
| Frontend units          | `frontend/test/`               | Card rendering fidelity, selection rules, board layout maths.                          |
| End-to-end              | `e2e/tests/`                   | Two real browsers in one room, on a phone and a desktop viewport.                      |
