/**
 * The authoritative game room — a pure state machine.
 *
 * This class owns deck order, board state, scores, phase, host identity,
 * membership and cooldowns. It has **no** dependency on Cloudflare, WebSockets,
 * storage or timers: commands go in, and a list of messages to deliver comes
 * out. The Durable Object in `worker/` is a thin adapter that serialises
 * transport concerns onto this engine, which is why the game rules can be
 * exhaustively tested in plain Node.
 *
 * Invariants maintained here:
 *  - Clients never learn deck order, other players' tokens, or where the sets are.
 *  - A claim only mutates the board it was made against (`boardVersion`).
 *  - Cooldowns are per-player and are only applied to a player's *own* mistakes.
 *  - The game can never sit on a set-less board while the deck still has cards
 *    and no way forward: "No SET on board" always resolves that position.
 */

import { INITIAL_BOARD_SIZE, SET_SIZE, cardById, freshDeckIds, type CardId } from './cards.js';
import {
  INVALID_ACTION_COOLDOWN_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  ROOM_IDLE_TTL_MS,
  type ClaimRejectReason,
  type ErrorCode,
  type GameEvent,
  type GamePhase,
  type NoSetRejectReason,
  type PublicPlayer,
  type PublicState,
  type ServerMessage,
} from './protocol.js';
import { secureRandomHex } from './random.js';
import { describeMismatchByIds, hasSet, isSetByIds } from './rules.js';
import { cryptoRandom, shuffled, type RandomSource } from './shuffle.js';

/** Where a produced message must be delivered. */
export type EmissionTarget = { kind: 'all' } | { kind: 'player'; playerId: string };

export interface Emission {
  target: EmissionTarget;
  message: ServerMessage;
}

export const toAll = (message: ServerMessage): Emission => ({ target: { kind: 'all' }, message });
export const toPlayer = (playerId: string, message: ServerMessage): Emission => ({
  target: { kind: 'player', playerId },
  message,
});

/** Runtime services the room needs. Swapped out wholesale in tests. */
export interface RoomEnv {
  /** Wall clock in epoch milliseconds. Client timestamps are never used. */
  now: () => number;
  /** Random source for shuffling. */
  random: RandomSource;
  /** Generates unguessable opaque ids (player ids and seat tokens). */
  newId: () => string;
}

/** 128 bits of entropy per id/token — unguessable, and short enough for a URL. */
const DEFAULT_ID_BYTES = 16;

export function defaultRoomEnv(): RoomEnv {
  return {
    now: () => Date.now(),
    random: cryptoRandom,
    newId: () => secureRandomHex(DEFAULT_ID_BYTES),
  };
}

interface PlayerRecord {
  id: string;
  /** Secret proving ownership of this seat. Never included in a snapshot. */
  token: string;
  name: string;
  score: number;
  connected: boolean;
  /** Monotonic seat number, used for stable ordering and host tie-breaks. */
  seat: number;
  /** When the current connection was established; drives host succession. */
  connectedSince: number;
  /** Set when the socket dropped; the seat is reclaimed after the grace period. */
  disconnectedAt: number | null;
  cooldownUntil: number;
  wantsRematch: boolean;
}

export interface JoinRequest {
  name: string;
  playerId?: string | undefined;
  token?: string | undefined;
}

export type JoinOutcome =
  | {
      ok: true;
      playerId: string;
      token: string;
      /** True when this connection took over a seat that was already connected. */
      replacedConnection: boolean;
      emissions: Emission[];
    }
  | { ok: false; code: ErrorCode; emissions: Emission[] };

export interface SerializedRoom {
  /** Storage schema version, for forward-compatible migrations. */
  s: 1;
  code: string;
  phase: GamePhase;
  players: PlayerRecord[];
  deck: CardId[];
  board: CardId[];
  boardVersion: number;
  setsFound: number;
  seatCounter: number;
  emptySince: number | null;
}

/** Player-visible copy for messages that must not leak the token. */
function publicPlayer(player: PlayerRecord, hostId: string | null): PublicPlayer {
  return {
    id: player.id,
    name: player.name,
    score: player.score,
    connected: player.connected,
    isHost: player.id === hostId,
    cooldownUntil: player.cooldownUntil,
    wantsRematch: player.wantsRematch,
  };
}

export class GameRoom {
  readonly code: string;
  private readonly env: RoomEnv;

  private phase: GamePhase = 'lobby';
  private players: PlayerRecord[] = [];
  private hostId: string | null = null;
  private deck: CardId[] = [];
  private board: CardId[] = [];
  private boardVersion = 0;
  private setsFound = 0;
  private seatCounter = 0;
  /** When the room last became empty, for idle cleanup. */
  private emptySince: number | null = null;

  constructor(code: string, env: RoomEnv = defaultRoomEnv()) {
    this.code = code;
    this.env = env;
    this.emptySince = env.now();
  }

  /* ---------------------------------------------------------------- *
   * Queries
   * ---------------------------------------------------------------- */

  getPhase(): GamePhase {
    return this.phase;
  }

  getHostId(): string | null {
    return this.hostId;
  }

  getBoard(): readonly CardId[] {
    return this.board;
  }

  getBoardVersion(): number {
    return this.boardVersion;
  }

  getDeckRemaining(): number {
    return this.deck.length;
  }

  playerCount(): number {
    return this.players.length;
  }

  connectedCount(): number {
    return this.players.filter((p) => p.connected).length;
  }

  getScore(playerId: string): number {
    return this.findPlayer(playerId)?.score ?? 0;
  }

  hasPlayer(playerId: string): boolean {
    return this.findPlayer(playerId) !== undefined;
  }

  isEmpty(): boolean {
    return this.players.length === 0;
  }

  /** Snapshot of everything clients are allowed to know. */
  snapshot(): PublicState {
    return {
      v: PROTOCOL_VERSION,
      code: this.code,
      phase: this.phase,
      players: this.players.map((p) => publicPlayer(p, this.hostId)),
      board: this.board.slice(),
      boardVersion: this.boardVersion,
      deckRemaining: this.deck.length,
      setsFound: this.setsFound,
      serverTime: this.env.now(),
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    };
  }

  /**
   * The next moment at which `tick()` has work to do (reconnect grace expiry, or
   * idle-room cleanup), or `null` when no timer is needed.
   */
  nextTimerAt(): number | null {
    let earliest: number | null = null;
    for (const player of this.players) {
      if (player.disconnectedAt !== null) {
        const at = player.disconnectedAt + RECONNECT_GRACE_MS;
        if (earliest === null || at < earliest) earliest = at;
      }
    }
    if (this.emptySince !== null) {
      const at = this.emptySince + ROOM_IDLE_TTL_MS;
      if (earliest === null || at < earliest) earliest = at;
    }
    return earliest;
  }

  /** True once the room has been empty long enough to be discarded. */
  isExpired(): boolean {
    return this.emptySince !== null && this.env.now() - this.emptySince >= ROOM_IDLE_TTL_MS;
  }

  /* ---------------------------------------------------------------- *
   * Membership
   * ---------------------------------------------------------------- */

  /**
   * Join a room, or resume an existing seat.
   *
   * Resuming requires the matching `playerId`/`token` pair, which is the only
   * thing preventing one client from impersonating another player. A mismatched
   * token is rejected outright rather than silently creating a new seat, so a
   * corrupted local state cannot steal someone else's score.
   */
  join(request: JoinRequest): JoinOutcome {
    const now = this.env.now();

    if (request.playerId !== undefined && request.token !== undefined) {
      const existing = this.findPlayer(request.playerId);
      if (existing) {
        if (existing.token !== request.token) {
          return { ok: false, code: 'not_authorized', emissions: [] };
        }
        const wasConnected = existing.connected;
        const reconnecting = existing.disconnectedAt !== null;
        existing.connected = true;
        existing.disconnectedAt = null;
        if (!wasConnected) existing.connectedSince = now;
        // Renaming is only allowed while nobody has started playing.
        if (this.phase === 'lobby') existing.name = this.uniqueName(request.name, existing.id);
        this.emptySince = null;
        this.hostId ??= existing.id;

        const emissions: Emission[] = [];
        if (reconnecting) {
          emissions.push(
            toAll(
              this.eventMessage({
                k: 'playerReconnected',
                playerId: existing.id,
                playerName: existing.name,
              }),
            ),
          );
        } else {
          emissions.push(toAll({ t: 'state', state: this.snapshot() }));
        }
        return {
          ok: true,
          playerId: existing.id,
          token: existing.token,
          replacedConnection: wasConnected,
          emissions,
        };
      }
      // Unknown credentials: fall through and treat this as a fresh join.
    }

    if (this.phase !== 'lobby') {
      return { ok: false, code: 'game_already_started', emissions: [] };
    }
    if (this.players.length >= MAX_PLAYERS) {
      return { ok: false, code: 'room_full', emissions: [] };
    }

    const player: PlayerRecord = {
      id: this.env.newId(),
      token: this.env.newId(),
      name: '',
      score: 0,
      connected: true,
      seat: this.seatCounter++,
      connectedSince: now,
      disconnectedAt: null,
      cooldownUntil: 0,
      wantsRematch: false,
    };
    player.name = this.uniqueName(request.name, player.id);
    this.players.push(player);
    this.emptySince = null;
    this.hostId ??= player.id;

    return {
      ok: true,
      playerId: player.id,
      token: player.token,
      replacedConnection: false,
      emissions: [
        toAll(
          this.eventMessage({ k: 'playerJoined', playerId: player.id, playerName: player.name }),
        ),
      ],
    };
  }

  /** Mark a player's socket as dropped, starting their reconnect grace period. */
  disconnect(playerId: string): Emission[] {
    const player = this.findPlayer(playerId);
    if (!player?.connected) return [];
    player.connected = false;
    player.disconnectedAt = this.env.now();
    const emissions: Emission[] = [
      toAll(
        this.eventMessage({
          k: 'playerDisconnected',
          playerId: player.id,
          playerName: player.name,
        }),
      ),
    ];
    emissions.push(...this.reassignHostIfNeeded());
    if (this.connectedCount() === 0) this.emptySince = this.env.now();
    return emissions;
  }

  /** Remove a player permanently at their own request. */
  leave(playerId: string): Emission[] {
    const player = this.findPlayer(playerId);
    if (!player) return [];
    this.players = this.players.filter((p) => p.id !== playerId);
    const emissions: Emission[] = [
      toAll(this.eventMessage({ k: 'playerLeft', playerId: player.id, playerName: player.name })),
    ];
    emissions.push(...this.reassignHostIfNeeded());
    if (this.connectedCount() === 0) this.emptySince = this.env.now();
    return emissions;
  }

  /**
   * Advance time-based state: reclaim seats whose grace period has elapsed.
   * Called from the Durable Object alarm; safe to call at any time.
   */
  tick(): Emission[] {
    const now = this.env.now();
    const expired = this.players.filter(
      (p) => p.disconnectedAt !== null && now - p.disconnectedAt >= RECONNECT_GRACE_MS,
    );
    if (expired.length === 0) return [];
    const expiredIds = new Set(expired.map((p) => p.id));
    this.players = this.players.filter((p) => !expiredIds.has(p.id));
    const emissions: Emission[] = expired.map((p) =>
      toAll(this.eventMessage({ k: 'playerLeft', playerId: p.id, playerName: p.name })),
    );
    emissions.push(...this.reassignHostIfNeeded());
    if (this.connectedCount() === 0 && this.emptySince === null) this.emptySince = now;
    return emissions;
  }

  /* ---------------------------------------------------------------- *
   * Game lifecycle
   * ---------------------------------------------------------------- */

  /** Host-only. Deals a fresh shuffled game to everyone in the lobby. */
  start(playerId: string): { ok: true; emissions: Emission[] } | { ok: false; code: ErrorCode } {
    if (this.phase !== 'lobby') return { ok: false, code: 'game_already_started' };
    if (playerId !== this.hostId) return { ok: false, code: 'not_host' };
    if (this.connectedCount() < MIN_PLAYERS) return { ok: false, code: 'not_enough_players' };
    this.beginGame();
    return { ok: true, emissions: [toAll(this.eventMessage({ k: 'gameStarted' }))] };
  }

  /**
   * "Play again". Any player may signal intent; only the host actually starts the
   * next game, which keeps one player from restarting while others read the
   * results screen.
   */
  rematch(playerId: string): { ok: true; emissions: Emission[] } | { ok: false; code: ErrorCode } {
    if (this.phase !== 'finished') return { ok: false, code: 'invalid_message' };
    const player = this.findPlayer(playerId);
    if (!player) return { ok: false, code: 'not_authorized' };

    if (playerId !== this.hostId) {
      if (player.wantsRematch) return { ok: true, emissions: [] };
      player.wantsRematch = true;
      return {
        ok: true,
        emissions: [
          toAll(
            this.eventMessage({ k: 'rematchWanted', playerId: player.id, playerName: player.name }),
          ),
        ],
      };
    }

    // Host starts the rematch: drop seats nobody is sitting in any more.
    const dropped = this.players.filter((p) => !p.connected);
    if (this.players.length - dropped.length < MIN_PLAYERS) {
      return { ok: false, code: 'not_enough_players' };
    }
    const droppedIds = new Set(dropped.map((p) => p.id));
    this.players = this.players.filter((p) => !droppedIds.has(p.id));
    const emissions: Emission[] = dropped.map((p) =>
      toAll(this.eventMessage({ k: 'playerLeft', playerId: p.id, playerName: p.name })),
    );
    emissions.push(...this.reassignHostIfNeeded());
    this.beginGame();
    emissions.push(toAll(this.eventMessage({ k: 'gameStarted' })));
    return { ok: true, emissions };
  }

  /* ---------------------------------------------------------------- *
   * Gameplay
   * ---------------------------------------------------------------- */

  /**
   * Submit exactly three cards as a SET.
   *
   * Ordering of the checks matters: a claim made stale by another player's
   * success must **not** be punished, so `board_changed` is decided before
   * validity. Cooldown is checked first because it is the most actionable
   * feedback for the player.
   */
  claim(playerId: string, cards: CardId[], boardVersion: number): Emission[] {
    const now = this.env.now();
    const player = this.findPlayer(playerId);
    if (!player) return [];

    const reject = (reason: ClaimRejectReason, cooldown: boolean): Emission[] => {
      if (cooldown) player.cooldownUntil = now + INVALID_ACTION_COOLDOWN_MS;
      const mismatch =
        reason === 'not_a_set' && cards.length === SET_SIZE
          ? describeMismatchByIds([cards[0]!, cards[1]!, cards[2]!])
          : null;
      const emissions: Emission[] = [
        toPlayer(playerId, {
          t: 'claimRejected',
          reason,
          mismatch,
          cooldownUntil: player.cooldownUntil,
          serverTime: now,
        }),
      ];
      if (reason === 'not_a_set') {
        emissions.push(
          toAll(
            this.eventMessage({ k: 'invalidClaim', playerId: player.id, playerName: player.name }),
          ),
        );
      }
      return emissions;
    };

    if (this.phase !== 'playing') return reject('not_playing', false);
    if (now < player.cooldownUntil) return reject('cooldown', false);
    if (cards.length !== SET_SIZE || new Set(cards).size !== SET_SIZE) {
      return reject('invalid_cards', false);
    }
    if (boardVersion !== this.boardVersion) return reject('board_changed', false);

    const indices = cards.map((id) => this.board.indexOf(id));
    if (indices.some((index) => index < 0)) return reject('board_changed', false);

    if (!isSetByIds(cards[0]!, cards[1]!, cards[2]!)) return reject('not_a_set', true);

    player.score += 1;
    this.setsFound += 1;
    this.removeClaimedCards(indices);

    const emissions: Emission[] = [
      toAll(
        this.eventMessage({
          k: 'setFound',
          playerId: player.id,
          playerName: player.name,
          cards: cards.slice(),
          score: player.score,
        }),
      ),
    ];
    emissions.push(...this.finishIfExhausted());
    return emissions;
  }

  /**
   * "No SET on board". The server recomputes the answer from the authoritative
   * board; a wrong call costs the caller a cooldown and never reveals a set.
   */
  noSet(playerId: string, boardVersion: number): Emission[] {
    const now = this.env.now();
    const player = this.findPlayer(playerId);
    if (!player) return [];

    const reject = (reason: NoSetRejectReason, cooldown: boolean): Emission[] => {
      if (cooldown) player.cooldownUntil = now + INVALID_ACTION_COOLDOWN_MS;
      const emissions: Emission[] = [
        toPlayer(playerId, {
          t: 'noSetRejected',
          reason,
          cooldownUntil: player.cooldownUntil,
          serverTime: now,
        }),
      ];
      if (reason === 'set_exists') {
        emissions.push(
          toAll(
            this.eventMessage({ k: 'noSetRejected', playerId: player.id, playerName: player.name }),
          ),
        );
      }
      return emissions;
    };

    if (this.phase !== 'playing') return reject('not_playing', false);
    if (now < player.cooldownUntil) return reject('cooldown', false);
    if (boardVersion !== this.boardVersion) return reject('board_changed', false);
    if (hasSet(this.board)) return reject('set_exists', true);

    if (this.deck.length >= SET_SIZE) {
      this.board.push(...this.draw(SET_SIZE));
      this.boardVersion += 1;
      return [
        toAll(
          this.eventMessage({
            k: 'cardsAdded',
            count: SET_SIZE,
            playerId: player.id,
            playerName: player.name,
          }),
        ),
      ];
    }
    // Correct call and nothing left to deal: the game is over.
    return this.finishGame();
  }

  /* ---------------------------------------------------------------- *
   * Persistence
   * ---------------------------------------------------------------- */

  serialize(): SerializedRoom {
    return {
      s: 1,
      code: this.code,
      phase: this.phase,
      players: this.players.map((p) => ({ ...p })),
      deck: this.deck.slice(),
      board: this.board.slice(),
      boardVersion: this.boardVersion,
      setsFound: this.setsFound,
      seatCounter: this.seatCounter,
      emptySince: this.emptySince,
    };
  }

  static deserialize(data: SerializedRoom, env: RoomEnv = defaultRoomEnv()): GameRoom {
    const room = new GameRoom(data.code, env);
    room.phase = data.phase;
    // A restored room has no live sockets: everyone starts inside their grace window.
    const now = env.now();
    room.players = data.players.map((p) => ({
      ...p,
      connected: false,
      disconnectedAt: p.disconnectedAt ?? now,
    }));
    room.deck = data.deck.slice();
    room.board = data.board.slice();
    room.boardVersion = data.boardVersion;
    room.setsFound = data.setsFound;
    room.seatCounter = data.seatCounter;
    room.emptySince = data.emptySince ?? now;
    room.hostId = null;
    room.reassignHostIfNeeded();
    return room;
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  private findPlayer(playerId: string): PlayerRecord | undefined {
    return this.players.find((p) => p.id === playerId);
  }

  private eventMessage(event: GameEvent): ServerMessage {
    return { t: 'event', event, state: this.snapshot() };
  }

  /** Append a numeric suffix when a name is already taken, so scores stay readable. */
  private uniqueName(desired: string, ownId: string): string {
    const taken = new Set(
      this.players.filter((p) => p.id !== ownId).map((p) => p.name.toLocaleLowerCase()),
    );
    if (!taken.has(desired.toLocaleLowerCase())) return desired;
    for (let suffix = 2; suffix <= MAX_PLAYERS + 1; suffix++) {
      const candidate = `${desired} (${suffix})`;
      if (!taken.has(candidate.toLocaleLowerCase())) return candidate;
    }
    return desired;
  }

  /**
   * Ensure the host is a connected player. Succession goes to the
   * longest-connected active player, tie-broken by seat order.
   */
  private reassignHostIfNeeded(): Emission[] {
    const currentHost = this.hostId === null ? undefined : this.findPlayer(this.hostId);
    if (currentHost?.connected) return [];

    const candidates = this.players.filter((p) => p.connected);
    if (candidates.length === 0) {
      // Keep the seated (but disconnected) host so a reconnect restores control.
      if (currentHost === undefined) this.hostId = this.players[0]?.id ?? null;
      return [];
    }
    candidates.sort((a, b) => a.connectedSince - b.connectedSince || a.seat - b.seat);
    const next = candidates[0]!;
    if (this.hostId === next.id) return [];
    this.hostId = next.id;
    return [
      toAll(this.eventMessage({ k: 'hostChanged', playerId: next.id, playerName: next.name })),
    ];
  }

  private draw(count: number): CardId[] {
    return this.deck.splice(0, count);
  }

  private beginGame(): void {
    this.deck = shuffled(freshDeckIds(), this.env.random);
    this.board = this.draw(INITIAL_BOARD_SIZE);
    this.boardVersion += 1;
    this.setsFound = 0;
    this.phase = 'playing';
    for (const player of this.players) {
      player.score = 0;
      player.cooldownUntil = 0;
      player.wantsRematch = false;
    }
  }

  /**
   * Remove claimed cards. When the board is at its standard size of 12 and the
   * deck still has cards, replacements land in the vacated slots so the layout
   * does not reshuffle under the players' fingers. Above 12 cards nothing is
   * dealt and the board shrinks back down.
   */
  private removeClaimedCards(indices: number[]): void {
    const ordered = indices.slice().sort((a, b) => a - b);
    if (this.board.length === INITIAL_BOARD_SIZE && this.deck.length >= SET_SIZE) {
      const replacements = this.draw(SET_SIZE);
      ordered.forEach((slot, i) => {
        this.board[slot] = replacements[i]!;
      });
    } else {
      for (const slot of ordered.slice().reverse()) this.board.splice(slot, 1);
    }
    this.boardVersion += 1;
  }

  /** End the game when the deck is empty and no set remains on the board. */
  private finishIfExhausted(): Emission[] {
    if (this.deck.length > 0) return [];
    if (hasSet(this.board)) return [];
    return this.finishGame();
  }

  private finishGame(): Emission[] {
    this.phase = 'finished';
    for (const player of this.players) player.wantsRematch = false;
    const best = this.players.reduce((max, p) => Math.max(max, p.score), 0);
    const winners = this.players.filter((p) => p.score === best);
    return [
      toAll(
        this.eventMessage({
          k: 'gameOver',
          winnerIds: winners.map((p) => p.id),
          winnerNames: winners.map((p) => p.name),
        }),
      ),
    ];
  }
}

/** Verify the board/deck invariants the game must always satisfy. Used by tests. */
export function checkRoomInvariants(room: GameRoom): string[] {
  const problems: string[] = [];
  const board = room.getBoard();
  const unique = new Set(board);
  if (unique.size !== board.length) problems.push('board contains duplicate cards');
  for (const id of board) {
    try {
      cardById(id);
    } catch {
      problems.push(`board contains invalid card id ${String(id)}`);
    }
  }
  if (room.getPhase() === 'playing') {
    if (board.length + room.getDeckRemaining() > 81) problems.push('more cards in play than exist');
    if (board.length % 3 !== 0) problems.push('board size is not a multiple of three');
    if (room.getDeckRemaining() > 0 && board.length < INITIAL_BOARD_SIZE) {
      problems.push('board is under-filled while the deck still has cards');
    }
  }
  if (room.getPhase() === 'finished' && room.getDeckRemaining() > 0 && hasSet(board)) {
    problems.push('game finished while a set was still available');
  }
  return problems;
}
