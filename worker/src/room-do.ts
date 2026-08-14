/**
 * `GameRoomDO` — the Durable Object that owns one game room.
 *
 * This class is deliberately thin: it handles transport (WebSocket accept,
 * frame parsing, fan-out), persistence and timers, and delegates every game
 * decision to the pure `GameRoom` engine in `@set/shared`. All mutations happen
 * inside a single Durable Object instance, so they are naturally serialised —
 * two players cannot claim the same three cards concurrently.
 */

import {
  GameRoom,
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type Emission,
  type ErrorCode,
  type SerializedRoom,
  type ServerMessage,
} from '@set/shared';

const STORAGE_KEY = 'room';
/** Frames per second a single socket may send before it is disconnected. */
const MAX_FRAMES_PER_WINDOW = 25;
const RATE_WINDOW_MS = 1_000;
/** WebSocket close code used for protocol/abuse violations. */
const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_NORMAL = 1000;

/** Short, non-technical text for each error code. Never leaks internals. */
const ERROR_TEXT: Record<ErrorCode, string> = {
  room_not_found: 'That room code does not exist. Check the code and try again.',
  room_full: 'This room is full.',
  game_already_started: 'This game has already started. Ask the host for a rematch invite.',
  invalid_name: 'Please choose a display name of 1 to 20 characters.',
  invalid_message: 'That action is not available right now.',
  not_authorized: 'This seat belongs to another player. Rejoin to get a new one.',
  not_host: 'Only the host can do that.',
  not_enough_players: 'You need at least two connected players.',
  protocol_version_mismatch: 'This page is out of date. Please reload to get the latest version.',
  room_closed: 'This room has closed.',
  internal_error: 'Something went wrong. Please try again.',
};

interface SocketMeta {
  playerId: string | null;
  /** Sliding-window frame counter for cheap per-socket rate limiting. */
  windowStart: number;
  framesInWindow: number;
}

export interface RoomEnvBindings {
  GAME_ROOM: DurableObjectNamespace;
}

export class GameRoomDO implements DurableObject {
  private readonly state: DurableObjectState;
  private room: GameRoom | null = null;
  private readonly sockets = new Map<WebSocket, SocketMeta>();
  /** One live socket per seat; a second connection for the same seat replaces the first. */
  private readonly byPlayer = new Map<string, WebSocket>();

  constructor(state: DurableObjectState, _env: RoomEnvBindings) {
    this.state = state;
    void this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<SerializedRoom>(STORAGE_KEY);
      if (stored) this.room = GameRoom.deserialize(stored);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case '/create':
        return this.handleCreate(url.searchParams.get('code') ?? '');
      case '/info':
        return this.handleInfo();
      case '/ws':
        return this.handleUpgrade(request, url.searchParams.get('code') ?? '');
      default:
        return json({ error: 'not_found' }, 404);
    }
  }

  /* ---------------------------------------------------------------- *
   * HTTP surface (internal — only reachable via the Worker)
   * ---------------------------------------------------------------- */

  private async handleCreate(code: string): Promise<Response> {
    if (this.room) return json({ error: 'already_exists' }, 409);
    this.room = new GameRoom(code);
    await this.persist();
    await this.rescheduleAlarm();
    return json({ ok: true, code });
  }

  private handleInfo(): Response {
    if (!this.room) return json({ exists: false }, 404);
    const { phase, maxPlayers } = this.room.snapshot();
    const players = this.room.playerCount();
    return json({
      exists: true,
      phase,
      players,
      maxPlayers,
      canJoin: phase === 'lobby' && players < maxPlayers,
    });
  }

  private handleUpgrade(request: Request, code: string): Response {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'expected_websocket' }, 426);
    }
    // A room must be created explicitly, so a typo'd code reports "not found"
    // instead of silently opening an empty room.
    if (!this.room) {
      return json({ error: 'room_not_found' }, 404);
    }
    if (this.room.code !== code) return json({ error: 'room_not_found' }, 404);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.set(server, { playerId: null, windowStart: Date.now(), framesInWindow: 0 });

    server.addEventListener('message', (event: MessageEvent) => {
      void this.onMessage(server, event.data);
    });
    server.addEventListener('close', () => {
      void this.onClose(server);
    });
    server.addEventListener('error', () => {
      void this.onClose(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------------------------------------------------------- *
   * WebSocket handling
   * ---------------------------------------------------------------- */

  private async onMessage(socket: WebSocket, data: unknown): Promise<void> {
    const meta = this.sockets.get(socket);
    if (!meta) return;

    if (!this.withinRateLimit(meta)) {
      this.sendTo(socket, {
        t: 'error',
        code: 'invalid_message',
        message: 'Too many actions at once. Reconnecting.',
        fatal: true,
      });
      this.closeSocket(socket, CLOSE_POLICY_VIOLATION, 'rate limit');
      return;
    }

    // Reject binary and oversized frames before doing any parsing work.
    if (typeof data !== 'string' || data.length > MAX_MESSAGE_BYTES) {
      this.sendError(socket, 'invalid_message', false);
      return;
    }

    const parsed = parseClientMessage(data);
    if (!parsed.ok) {
      this.sendError(socket, 'invalid_message', false);
      return;
    }

    try {
      await this.dispatch(socket, meta, parsed.value);
    } catch {
      // Never surface a stack trace or internal detail to a player.
      this.sendError(socket, 'internal_error', false);
    }
  }

  private async dispatch(
    socket: WebSocket,
    meta: SocketMeta,
    message: ClientMessage,
  ): Promise<void> {
    const room = this.room;
    if (!room) {
      this.sendError(socket, 'room_closed', true);
      this.closeSocket(socket, CLOSE_NORMAL, 'room closed');
      return;
    }

    if (message.t === 'ping') {
      this.sendTo(socket, { t: 'pong', serverTime: Date.now() });
      return;
    }

    if (message.t === 'hello') {
      if (meta.playerId !== null) {
        // A second hello on the same socket is meaningless; ignore it safely.
        this.sendError(socket, 'invalid_message', false);
        return;
      }
      if (message.v !== PROTOCOL_VERSION) {
        this.sendError(socket, 'protocol_version_mismatch', true);
        this.closeSocket(socket, CLOSE_NORMAL, 'protocol version');
        return;
      }

      const outcome = room.join({
        name: message.name,
        playerId: message.playerId,
        token: message.token,
      });
      if (!outcome.ok) {
        this.sendError(socket, outcome.code, true);
        this.closeSocket(socket, CLOSE_NORMAL, outcome.code);
        return;
      }

      // Bind the socket to the seat, evicting any earlier socket on that seat so
      // one player can never hold two voices in the room.
      const previous = this.byPlayer.get(outcome.playerId);
      if (previous && previous !== socket) {
        const previousMeta = this.sockets.get(previous);
        if (previousMeta) previousMeta.playerId = null;
        this.closeSocket(previous, CLOSE_NORMAL, 'replaced by a newer connection');
      }
      meta.playerId = outcome.playerId;
      this.byPlayer.set(outcome.playerId, socket);

      // Welcome first (it carries the seat token), then the membership event.
      this.sendTo(socket, {
        t: 'welcome',
        v: PROTOCOL_VERSION,
        you: { playerId: outcome.playerId, token: outcome.token },
        state: room.snapshot(),
      });
      await this.deliver(outcome.emissions);
      return;
    }

    // Every remaining message requires an established seat on this socket.
    const playerId = meta.playerId;
    if (playerId === null || !room.hasPlayer(playerId)) {
      this.sendError(socket, 'not_authorized', true);
      this.closeSocket(socket, CLOSE_NORMAL, 'no seat');
      return;
    }

    switch (message.t) {
      case 'start': {
        const result = room.start(playerId);
        if (!result.ok) this.sendError(socket, result.code, false);
        else await this.deliver(result.emissions);
        return;
      }
      case 'claim':
        await this.deliver(room.claim(playerId, message.cards, message.boardVersion));
        return;
      case 'noSet':
        await this.deliver(room.noSet(playerId, message.boardVersion));
        return;
      case 'rematch': {
        const result = room.rematch(playerId);
        if (!result.ok) this.sendError(socket, result.code, false);
        else await this.deliver(result.emissions);
        return;
      }
      case 'leave': {
        meta.playerId = null;
        this.byPlayer.delete(playerId);
        await this.deliver(room.leave(playerId));
        this.closeSocket(socket, CLOSE_NORMAL, 'left');
        return;
      }
      default:
        this.sendError(socket, 'invalid_message', false);
        return;
    }
  }

  private async onClose(socket: WebSocket): Promise<void> {
    const meta = this.sockets.get(socket);
    this.sockets.delete(socket);
    if (!meta?.playerId || !this.room) return;
    // Only treat this as a disconnect if the seat still points at this socket;
    // otherwise a newer connection has already taken over.
    if (this.byPlayer.get(meta.playerId) !== socket) return;
    this.byPlayer.delete(meta.playerId);
    await this.deliver(this.room.disconnect(meta.playerId));
  }

  private withinRateLimit(meta: SocketMeta): boolean {
    const now = Date.now();
    if (now - meta.windowStart >= RATE_WINDOW_MS) {
      meta.windowStart = now;
      meta.framesInWindow = 0;
    }
    meta.framesInWindow += 1;
    return meta.framesInWindow <= MAX_FRAMES_PER_WINDOW;
  }

  /* ---------------------------------------------------------------- *
   * Delivery, persistence and timers
   * ---------------------------------------------------------------- */

  /** Route engine output to the right sockets, then persist and re-arm the alarm. */
  private async deliver(emissions: Emission[]): Promise<void> {
    for (const emission of emissions) {
      if (emission.target.kind === 'all') {
        this.broadcast(emission.message);
      } else {
        const socket = this.byPlayer.get(emission.target.playerId);
        if (socket) this.sendTo(socket, emission.message);
      }
    }
    if (emissions.length > 0) {
      await this.persist();
      await this.rescheduleAlarm();
    }
  }

  private broadcast(message: ServerMessage): void {
    const payload = JSON.stringify(message);
    for (const socket of this.sockets.keys()) {
      const meta = this.sockets.get(socket);
      // Sockets that have not said hello yet are not part of the room.
      if (!meta?.playerId) continue;
      this.rawSend(socket, payload);
    }
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    this.rawSend(socket, JSON.stringify(message));
  }

  private sendError(socket: WebSocket, code: ErrorCode, fatal: boolean): void {
    this.sendTo(socket, { t: 'error', code, message: ERROR_TEXT[code], fatal });
  }

  private rawSend(socket: WebSocket, payload: string): void {
    try {
      socket.send(payload);
    } catch {
      // The socket is already gone; the close handler will clean it up.
      this.sockets.delete(socket);
    }
  }

  private closeSocket(socket: WebSocket, code: number, reason: string): void {
    this.sockets.delete(socket);
    try {
      socket.close(code, reason.slice(0, 120));
    } catch {
      // Already closed.
    }
  }

  private async persist(): Promise<void> {
    if (!this.room) return;
    await this.state.storage.put(STORAGE_KEY, this.room.serialize());
  }

  private async rescheduleAlarm(): Promise<void> {
    const at = this.room?.nextTimerAt() ?? null;
    if (at === null) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const existing = await this.state.storage.getAlarm();
    // Only rewrite the alarm when it would fire too late; avoids churn on every claim.
    if (existing === null || existing > at) {
      await this.state.storage.setAlarm(Math.max(at, Date.now() + 1_000));
    }
  }

  /**
   * Fires for reconnect-grace expiry and idle-room cleanup. Reclaiming a seat is
   * a normal state transition, so it broadcasts like any other event.
   */
  async alarm(): Promise<void> {
    const room = this.room;
    if (!room) return;
    const emissions = room.tick();
    for (const emission of emissions) {
      if (emission.target.kind === 'all') this.broadcast(emission.message);
    }
    if (room.isEmpty() && room.isExpired()) {
      this.room = null;
      await this.state.storage.deleteAll();
      for (const socket of [...this.sockets.keys()]) {
        this.closeSocket(socket, CLOSE_NORMAL, 'room closed');
      }
      return;
    }
    await this.persist();
    const at = room.nextTimerAt();
    if (at !== null) {
      await this.state.storage.setAlarm(Math.max(at, Date.now() + 1_000));
    }
  }
}

/** Small JSON helper shared by the internal endpoints. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
