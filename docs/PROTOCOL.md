# Wire protocol v2

Source of truth: `shared/src/protocol.ts`. The types there describe the wire and
`parseClientMessage` enforces it at runtime — TypeScript types are never trusted
for anything arriving on a socket.

`PROTOCOL_VERSION` is sent by the client in its first frame. A mismatch is
answered with a fatal `protocol_version_mismatch`, which the UI shows as "reload
to get the latest version" — the case where a browser has a stale cached bundle.
Bump the version whenever a message shape changes incompatibly.

## HTTP

| Method | Path                  | Purpose                                                                                  |
| ------ | --------------------- | ---------------------------------------------------------------------------------------- |
| `GET`  | `/health`             | Liveness. `{"ok":true,"protocol":2}`.                                                    |
| `POST` | `/api/rooms`          | Create a room. `201 {"code":"ABC234","protocol":2}`.                                     |
| `GET`  | `/api/rooms/:code`    | Pre-join check: `{exists, phase, players, maxPlayers, canJoin}`, or `404` / `400`.       |
| `GET`  | `/api/rooms/:code/ws` | WebSocket upgrade. `404` if the room was never created, `426` without an upgrade header. |

Room codes are 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` — the
alphabet omits `I`, `O`, `0` and `1` so a code read aloud or off a screen is
unambiguous.

Origins are allow-listed by the `ALLOWED_ORIGINS` Worker variable; `localhost`
and `127.0.0.1` are always permitted so local development needs no
configuration. A rejected origin gets `403 {"error":"origin_not_allowed"}` with a
message naming the variable to fix.

## Client → server

All frames are JSON text, at most 1,024 bytes. A socket sending more than 25
frames per second is closed with code 1008.

| Frame                                                          | Notes                                                                        |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `{"t":"hello","v":2,"name":"Maya"}`                            | First frame. Required before anything else.                                  |
| `{"t":"hello","v":2,"name":"Maya","playerId":"…","token":"…"}` | Resume a seat. Both credentials required together, or the frame is refused.  |
| `{"t":"start"}`                                                | Host only, lobby only, ≥2 connected players.                                 |
| `{"t":"claim","cards":[0,40,80],"boardVersion":7}`             | Exactly three distinct card ids in `0..80`.                                  |
| `{"t":"noSet","boardVersion":7}`                               | "No SET on board".                                                           |
| `{"t":"deal","want":true,"boardVersion":7}`                    | Ask for three more cards, or withdraw with `false`. Unanimous vote.          |
| `{"t":"hint","level":1,"boardVersion":7}`                      | Ask for a hint. `level` is `1` or `2`; anything else is refused.             |
| `{"t":"rematch"}`                                              | From the host it starts a new game; from anyone else it registers readiness. |
| `{"t":"leave"}`                                                | Gives up the seat immediately.                                               |
| `{"t":"ping"}`                                                 | Keep-alive; answered with `pong`.                                            |

Unknown properties are dropped rather than forwarded. Unknown message types,
malformed JSON, binary frames and oversized frames all produce a non-fatal
`invalid_message` and leave the connection usable.

## Server → client

| Frame                                                    | Delivery  | Notes                                                                            |
| -------------------------------------------------------- | --------- | -------------------------------------------------------------------------------- |
| `{"t":"welcome","v":2,"you":{playerId,token},"state":…}` | Private   | The only frame that ever contains this player's token.                           |
| `{"t":"state","state":…}`                                | Broadcast | Full authoritative snapshot.                                                     |
| `{"t":"event","event":…,"state":…}`                      | Broadcast | An event bundled with the state it produced, so they cannot arrive out of order. |
| `{"t":"claimRejected","reason":…,"mismatch":…,…}`        | Private   | Why _this_ player's claim failed. Others never see it.                           |
| `{"t":"noSetRejected","reason":…,…}`                     | Private   | Why this player's "no SET" call failed.                                          |
| `{"t":"hintRevealed","level":1,"cards":[12],…}`          | Private   | The only frame that ever names cards belonging to a set. Never broadcast.        |
| `{"t":"hintRejected","reason":…,"availableAt":…,…}`      | Private   | Why the hint was refused; `availableAt` is when that level unlocks.              |
| `{"t":"dealRejected","reason":…}`                        | Private   | Why a request for more cards could not be registered.                            |
| `{"t":"error","code":…,"message":…,"fatal":…}`           | Private   | `message` is short, non-technical and safe to display verbatim.                  |
| `{"t":"pong","serverTime":…}`                            | Private   | Also used to re-sync the clock offset.                                           |

### `PublicState`

```jsonc
{
  "v": 2,
  "code": "ABC234",
  "phase": "lobby" | "playing" | "finished",
  "players": [
    { "id": "…", "name": "Maya", "score": 3, "connected": true,
      "isHost": true, "cooldownUntil": 0, "wantsRematch": false }
  ],
  "board": [12, 47, 3, …],   // face-up card ids, in stable slot order
  "boardVersion": 7,         // increments on every board mutation
  "deckRemaining": 57,
  "setsFound": 4,
  "serverTime": 1739536000000, // lets clients render cooldowns despite clock drift
  "minPlayers": 2,
  "maxPlayers": 8,
  "dealVotes": ["…"],        // players currently asking for three more cards
  "dealVoteExpiresAt": 0,    // when that request lapses; 0 when nobody is asking
  "boardSince": 1739536000000 // when this board appeared; both hint clocks count from here
}
```

What is deliberately **absent**: deck order, any player's token, and anything
that would reveal where a set is. Cooldown deadlines are on the server clock;
clients convert using `serverTime`.

### Events

`playerJoined`, `playerLeft`, `playerDisconnected`, `playerReconnected`,
`hostChanged`, `gameStarted`, `setFound`, `invalidClaim`, `cardsAdded`,
`noSetRejected`, `dealVote`, `dealLapsed`, `hintUsed`, `rematchWanted`,
`gameOver`.

`invalidClaim` tells everyone that a claim failed but carries no card ids and no
mismatch — the explanation goes only to the player who made the claim.

`hintUsed` likewise names the player and the level, never the cards. `cardsAdded`
carries `reason`: `noSet` for a correct "No SET on board" call, `agreed` when the
whole table asked for them.

### Reject reasons

Claims: `not_a_set`, `board_changed`, `cooldown`, `not_playing`, `invalid_cards`.
"No SET" calls: `set_exists`, `cooldown`, `not_playing`, `board_changed`.
Requests for more cards: `deck_empty`, `board_full`, `not_playing`, `board_changed`.
Hints: `too_soon`, `no_set`, `not_playing`, `board_changed`.

Only `not_a_set` and `set_exists` apply the 5-second cooldown. `board_changed`
never does: being beaten to a set is not a mistake. Asking for cards or for a
hint never costs a cooldown either, and both are allowed while one is running —
they are requests, not moves on the board.

### Error codes

`room_not_found`, `room_full`, `game_already_started`, `invalid_name`,
`invalid_message`, `not_authorized`, `not_host`, `not_enough_players`,
`protocol_version_mismatch`, `room_closed`, `internal_error`.

`fatal: true` means the socket is closing and retrying unchanged will not help.
Internal errors are logged nowhere sensitive and never expose a stack trace.

## Constants

| Constant                      | Value          |
| ----------------------------- | -------------- |
| `MIN_PLAYERS` / `MAX_PLAYERS` | 2 / 8          |
| `MAX_NAME_LENGTH`             | 20 code points |
| `ROOM_CODE_LENGTH`            | 6              |
| `INVALID_ACTION_COOLDOWN_MS`  | 5,000          |
| `RECONNECT_GRACE_MS`          | 60,000         |
| `MAX_MESSAGE_BYTES`           | 1,024          |
| `ROOM_IDLE_TTL_MS`            | 1,800,000      |
| `MAX_BOARD_SIZE`              | 21             |
| `DEAL_VOTE_TTL_MS`            | 45,000         |
| `HINT_LEVEL_1_AFTER_MS`       | 60,000         |
| `HINT_LEVEL_2_AFTER_MS`       | 120,000        |
