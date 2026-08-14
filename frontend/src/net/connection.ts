/**
 * The game socket: one WebSocket to the room's Durable Object, with automatic
 * reconnection and exponential backoff.
 *
 * The client is intentionally dumb. It sends intents and applies whatever
 * authoritative state the server returns; it never computes scores, board
 * changes or validity locally.
 */

import { PROTOCOL_VERSION, type ClientMessage, type ServerMessage } from '@set/shared';
import { wsBase } from '../config.js';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ConnectionHandlers {
  onStatus: (status: ConnectionStatus, attempt: number) => void;
  onMessage: (message: ServerMessage) => void;
  /** Called when reconnecting cannot help — a fatal server error or giving up. */
  onFatal: (reason: 'server' | 'unreachable') => void;
}

export interface Credentials {
  playerId: string;
  token: string;
}

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000];
const MAX_ATTEMPTS = 8;
/** Keep-alive interval; also detects a half-open socket via the missing pong. */
const PING_INTERVAL_MS = 25_000;

export class GameConnection {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'idle';
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  /** Set when reconnecting cannot help (player left, or a fatal server error). */
  private stopped = false;
  private onlineListener: (() => void) | null = null;
  private credentials: Credentials | null = null;

  constructor(
    private readonly code: string,
    private readonly name: string,
    private readonly handlers: ConnectionHandlers,
  ) {}

  /** Resume an existing seat instead of taking a new one. */
  setCredentials(credentials: Credentials | null): void {
    this.credentials = credentials;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  connect(): void {
    if (this.stopped) return;
    this.installOnlineListener();
    this.clearReconnectTimer();
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(`${wsBase()}/api/rooms/${encodeURIComponent(this.code)}/ws`);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.attempt = 0;
      this.setStatus('open');
      this.sendHello();
      this.startPing();
    });

    socket.addEventListener('message', (event: MessageEvent) => {
      const message = this.parse(event.data);
      if (!message) return;
      if (message.t === 'welcome') {
        this.credentials = { playerId: message.you.playerId, token: message.you.token };
      }
      if (message.t === 'error' && message.fatal) {
        // Reconnecting with the same inputs would fail the same way.
        this.stopped = true;
        this.handlers.onMessage(message);
        this.teardown();
        this.setStatus('closed');
        this.handlers.onFatal('server');
        return;
      }
      this.handlers.onMessage(message);
    });

    socket.addEventListener('close', () => {
      this.stopPing();
      if (this.stopped) {
        this.setStatus('closed');
        return;
      }
      this.scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      // `close` always follows; reconnection is handled there.
    });
  }

  send(message: ClientMessage): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** Leave for good: tell the room, then stop reconnecting. */
  leave(): void {
    this.send({ t: 'leave' });
    this.stopped = true;
    this.teardown();
    this.setStatus('closed');
  }

  /** Manual retry after the automatic attempts were exhausted. */
  retry(): void {
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  /**
   * When the device reports the network is back, reconnect at once instead of
   * waiting out the remaining backoff — that delay is what makes an app feel
   * broken after a tunnel or a lift.
   */
  private installOnlineListener(): void {
    if (this.onlineListener) return;
    this.onlineListener = (): void => {
      if (this.stopped) return;
      if (this.status === 'reconnecting' || this.status === 'closed') {
        this.attempt = 0;
        this.connect();
      }
    };
    globalThis.addEventListener('online', this.onlineListener);
  }

  private sendHello(): void {
    const message: ClientMessage = this.credentials
      ? {
          t: 'hello',
          v: PROTOCOL_VERSION,
          name: this.name,
          playerId: this.credentials.playerId,
          token: this.credentials.token,
        }
      : { t: 'hello', v: PROTOCOL_VERSION, name: this.name };
    this.send(message);
  }

  private parse(data: unknown): ServerMessage | null {
    if (typeof data !== 'string') return null;
    try {
      // The server is the authority; we still guard against a truncated frame.
      const parsed = JSON.parse(data) as ServerMessage;
      return typeof parsed === 'object' && parsed !== null && typeof parsed.t === 'string'
        ? parsed
        : null;
    } catch {
      return null;
    }
  }

  private scheduleReconnect(): void {
    this.teardownSocket();
    if (this.attempt >= MAX_ATTEMPTS) {
      this.setStatus('closed');
      this.handlers.onFatal('unreachable');
      return;
    }
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt += 1;
    this.setStatus('reconnecting');
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => this.send({ t: 'ping' }), PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private teardownSocket(): void {
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }

  private teardown(): void {
    this.clearReconnectTimer();
    this.stopPing();
    this.teardownSocket();
    if (this.onlineListener) {
      globalThis.removeEventListener('online', this.onlineListener);
      this.onlineListener = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus(status, this.attempt);
  }
}
