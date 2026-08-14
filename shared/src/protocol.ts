/**
 * Wire protocol shared by the browser client and the Durable Object.
 *
 * Versioning: `PROTOCOL_VERSION` is sent by the client in its first frame and
 * echoed by the server. A mismatch is reported as a fatal, non-technical error
 * so a stale cached frontend tells the player to reload rather than
 * misbehaving. Bump it whenever a message shape changes incompatibly.
 *
 * Everything here is data-only: the types describe the wire, and the
 * `parseClientMessage` validator enforces them at runtime. TypeScript types are
 * never trusted for input coming off a socket.
 */

import { SET_SIZE, isCardId, type CardId } from './cards.js';
import type { AttributeMismatch } from './rules.js';

export const PROTOCOL_VERSION = 1;

/** Room limits. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const MAX_NAME_LENGTH = 20;
export const ROOM_CODE_LENGTH = 6;
/** Code alphabet with visually confusable characters (I, O, 0, 1) removed. */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Cooldown applied to a single player after an invalid claim or bad no-set call. */
export const INVALID_ACTION_COOLDOWN_MS = 5_000;
/** How long a disconnected player keeps their seat, score and identity. */
export const RECONNECT_GRACE_MS = 60_000;
/** Largest inbound frame the server will parse. Anything bigger is dropped. */
export const MAX_MESSAGE_BYTES = 1_024;
/** Rooms with no connected players are cleaned up after this long. */
export const ROOM_IDLE_TTL_MS = 30 * 60_000;

export type GamePhase = 'lobby' | 'playing' | 'finished';

/* ------------------------------------------------------------------ *
 * Public state snapshot
 * ------------------------------------------------------------------ */

export interface PublicPlayer {
  id: string;
  name: string;
  /** Number of successful SET claims. */
  score: number;
  connected: boolean;
  isHost: boolean;
  /** Server-clock epoch ms until which this player may not claim; 0 when free. */
  cooldownUntil: number;
  wantsRematch: boolean;
}

/**
 * The complete state every client is allowed to see. It deliberately contains
 * no deck order, no player tokens and no hint of where the sets are.
 */
export interface PublicState {
  v: number;
  code: string;
  phase: GamePhase;
  /** Ordered by seat (join order). */
  players: PublicPlayer[];
  /** Face-up cards, in stable slot order. */
  board: CardId[];
  /** Increments on every board mutation; claims must reference the current value. */
  boardVersion: number;
  deckRemaining: number;
  /** Total accepted claims this game, across all players. */
  setsFound: number;
  /** Server clock at send time, so clients can render cooldowns without clock drift. */
  serverTime: number;
  minPlayers: number;
  maxPlayers: number;
}

/* ------------------------------------------------------------------ *
 * Events (for the activity feed, animations and aria-live output)
 * ------------------------------------------------------------------ */

export type GameEvent =
  | { k: 'playerJoined'; playerId: string; playerName: string }
  | { k: 'playerLeft'; playerId: string; playerName: string }
  | { k: 'playerDisconnected'; playerId: string; playerName: string }
  | { k: 'playerReconnected'; playerId: string; playerName: string }
  | { k: 'hostChanged'; playerId: string; playerName: string }
  | { k: 'gameStarted' }
  | { k: 'setFound'; playerId: string; playerName: string; cards: CardId[]; score: number }
  | { k: 'invalidClaim'; playerId: string; playerName: string }
  | { k: 'cardsAdded'; count: number; playerId: string; playerName: string }
  | { k: 'noSetRejected'; playerId: string; playerName: string }
  | { k: 'rematchWanted'; playerId: string; playerName: string }
  | { k: 'gameOver'; winnerIds: string[]; winnerNames: string[] };

export type GameEventKind = GameEvent['k'];

/* ------------------------------------------------------------------ *
 * Client -> server
 * ------------------------------------------------------------------ */

export interface HelloMessage {
  t: 'hello';
  v: number;
  name: string;
  /** Present when resuming a seat after a reload or network blip. */
  playerId?: string;
  /** Secret paired with `playerId`; proves the client owns that seat. */
  token?: string;
}

export interface StartMessage {
  t: 'start';
}

export interface ClaimMessage {
  t: 'claim';
  cards: CardId[];
  /** Board revision the selection was made against; guards against stale claims. */
  boardVersion: number;
}

export interface NoSetMessage {
  t: 'noSet';
  boardVersion: number;
}

export interface RematchMessage {
  t: 'rematch';
}

export interface LeaveMessage {
  t: 'leave';
}

export interface PingMessage {
  t: 'ping';
}

export type ClientMessage =
  | HelloMessage
  | StartMessage
  | ClaimMessage
  | NoSetMessage
  | RematchMessage
  | LeaveMessage
  | PingMessage;

/* ------------------------------------------------------------------ *
 * Server -> client
 * ------------------------------------------------------------------ */

export type ErrorCode =
  | 'room_not_found'
  | 'room_full'
  | 'game_already_started'
  | 'invalid_name'
  | 'invalid_message'
  | 'not_authorized'
  | 'not_host'
  | 'not_enough_players'
  | 'protocol_version_mismatch'
  | 'room_closed'
  | 'internal_error';

export type ClaimRejectReason =
  'not_a_set' | 'board_changed' | 'cooldown' | 'not_playing' | 'invalid_cards';

export type NoSetRejectReason = 'set_exists' | 'cooldown' | 'not_playing' | 'board_changed';

export interface WelcomeMessage {
  t: 'welcome';
  v: number;
  you: { playerId: string; token: string };
  state: PublicState;
}

export interface StateMessage {
  t: 'state';
  state: PublicState;
}

/** An event plus the state it produced, so clients never render them out of order. */
export interface EventMessage {
  t: 'event';
  event: GameEvent;
  state: PublicState;
}

/** Private feedback for the claiming player only. */
export interface ClaimRejectedMessage {
  t: 'claimRejected';
  reason: ClaimRejectReason;
  /** Present for `not_a_set`: the attribute that had two the same and one different. */
  mismatch: AttributeMismatch | null;
  cooldownUntil: number;
  serverTime: number;
}

/** Private feedback for the player who called "no SET". */
export interface NoSetRejectedMessage {
  t: 'noSetRejected';
  reason: NoSetRejectReason;
  cooldownUntil: number;
  serverTime: number;
}

export interface ErrorMessage {
  t: 'error';
  code: ErrorCode;
  /** Short, non-technical, safe to display. Never contains internals. */
  message: string;
  /** When true the socket is about to close and retrying as-is will not help. */
  fatal: boolean;
}

export interface PongMessage {
  t: 'pong';
  serverTime: number;
}

export type ServerMessage =
  | WelcomeMessage
  | StateMessage
  | EventMessage
  | ClaimRejectedMessage
  | NoSetRejectedMessage
  | ErrorMessage
  | PongMessage;

/* ------------------------------------------------------------------ *
 * Runtime validation
 * ------------------------------------------------------------------ */

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalise a display name: strip control characters, collapse whitespace, trim.
 * Returns `null` when nothing usable remains or the result is too long.
 *
 * Names are only ever rendered as text nodes, never as HTML, so no escaping is
 * required — but control characters and bidi overrides are removed anyway to
 * stop players from mangling other people's layout.
 */
export function normalizeName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input
    // C0/C1 controls, plus bidi/format characters that can visually reorder text.
    // Matching control characters is the whole point here, hence the exemption.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length === 0) return null;
  if ([...cleaned].length > MAX_NAME_LENGTH) return null;
  return cleaned;
}

/** Uppercase and validate a room code. Returns `null` when malformed. */
export function normalizeRoomCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  if (code.length !== ROOM_CODE_LENGTH) return null;
  for (const ch of code) {
    if (!ROOM_CODE_ALPHABET.includes(ch)) return null;
  }
  return code;
}

/** Opaque server-issued ids: 8–64 chars of `[A-Za-z0-9_-]`. */
function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

function isBoardVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1e9;
}

/**
 * Parse and validate an inbound frame. Every branch is explicit — no schema
 * library, no reliance on TypeScript, and unknown extra properties are ignored
 * rather than forwarded.
 */
export function parseClientMessage(raw: unknown): ParseResult<ClientMessage> {
  if (typeof raw !== 'string') return { ok: false, error: 'frame must be text' };
  if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, error: 'frame too large' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'malformed JSON' };
  }
  if (!isPlainObject(parsed)) return { ok: false, error: 'frame must be an object' };

  const type = parsed['t'];
  switch (type) {
    case 'hello': {
      if (typeof parsed['v'] !== 'number') return { ok: false, error: 'hello.v missing' };
      const name = normalizeName(parsed['name']);
      if (name === null) return { ok: false, error: 'hello.name invalid' };
      const message: HelloMessage = { t: 'hello', v: parsed['v'], name };
      const playerId = parsed['playerId'];
      const token = parsed['token'];
      if (playerId !== undefined || token !== undefined) {
        // Resume credentials are only accepted as a matched pair.
        if (!isOpaqueId(playerId) || !isOpaqueId(token)) {
          return { ok: false, error: 'hello resume credentials invalid' };
        }
        message.playerId = playerId;
        message.token = token;
      }
      return { ok: true, value: message };
    }
    case 'claim': {
      const cards = parsed['cards'];
      if (!Array.isArray(cards) || cards.length !== SET_SIZE) {
        return { ok: false, error: 'claim.cards must have exactly 3 entries' };
      }
      if (!cards.every(isCardId)) return { ok: false, error: 'claim.cards must be card ids' };
      const ids = cards;
      if (new Set(ids).size !== SET_SIZE) {
        return { ok: false, error: 'claim.cards must be distinct' };
      }
      if (!isBoardVersion(parsed['boardVersion'])) {
        return { ok: false, error: 'claim.boardVersion invalid' };
      }
      return { ok: true, value: { t: 'claim', cards: ids, boardVersion: parsed['boardVersion'] } };
    }
    case 'noSet': {
      if (!isBoardVersion(parsed['boardVersion'])) {
        return { ok: false, error: 'noSet.boardVersion invalid' };
      }
      return { ok: true, value: { t: 'noSet', boardVersion: parsed['boardVersion'] } };
    }
    case 'start':
      return { ok: true, value: { t: 'start' } };
    case 'rematch':
      return { ok: true, value: { t: 'rematch' } };
    case 'leave':
      return { ok: true, value: { t: 'leave' } };
    case 'ping':
      return { ok: true, value: { t: 'ping' } };
    default:
      return { ok: false, error: `unknown message type: ${String(type)}` };
  }
}
