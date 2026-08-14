/**
 * Test harness for the integration suite.
 *
 * These tests talk to a real `wrangler dev` process over real WebSockets, so
 * they exercise workerd, the Durable Object lifecycle, storage and alarms —
 * not a mock. `globalSetup.ts` starts and stops the server.
 */

import { PROTOCOL_VERSION } from '@set/shared';
import type { ClientMessage, GameEvent, PublicState, ServerMessage } from '@set/shared';

export const BASE_URL = process.env['SET_TEST_BASE_URL'] ?? 'http://127.0.0.1:8788';
export const WS_URL = BASE_URL.replace(/^http/, 'ws');

const DEFAULT_TIMEOUT_MS = 5_000;

export async function createRoom(): Promise<string> {
  const response = await fetch(`${BASE_URL}/api/rooms`, { method: 'POST' });
  if (!response.ok) throw new Error(`createRoom failed: ${response.status}`);
  const body = (await response.json()) as { code: string };
  return body.code;
}

export async function roomInfo(code: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${BASE_URL}/api/rooms/${code}`);
  return { status: response.status, body: await response.json() };
}

/** A single player's connection, recording every frame the server sends. */
export class TestClient {
  readonly received: ServerMessage[] = [];
  playerId = '';
  token = '';
  closeCode: number | null = null;
  private socket: WebSocket | null = null;

  constructor(readonly code: string) {}

  async connect(): Promise<void> {
    const socket = new WebSocket(`${WS_URL}/api/rooms/${this.code}/ws`);
    this.socket = socket;
    socket.addEventListener('message', (event: MessageEvent) => {
      this.received.push(JSON.parse(String(event.data)) as ServerMessage);
    });
    socket.addEventListener('close', (event: CloseEvent) => {
      this.closeCode = event.code;
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new Error('socket error')), { once: true });
    });
  }

  send(message: ClientMessage): void {
    this.socket?.send(JSON.stringify(message));
  }

  /** Send a raw string, for testing malformed and oversized frames. */
  sendRaw(payload: string): void {
    this.socket?.send(payload);
  }

  close(): void {
    try {
      this.socket?.close();
    } catch {
      /* already closed */
    }
  }

  /** Say hello and wait for the welcome (or a fatal error). */
  async hello(name: string, resume?: { playerId: string; token: string }): Promise<ServerMessage> {
    const message: ClientMessage = resume
      ? {
          t: 'hello',
          v: PROTOCOL_VERSION,
          name,
          playerId: resume.playerId,
          token: resume.token,
        }
      : { t: 'hello', v: PROTOCOL_VERSION, name };
    this.send(message);
    const reply = await this.waitFor((m) => m.t === 'welcome' || m.t === 'error');
    if (reply.t === 'welcome') {
      this.playerId = reply.you.playerId;
      this.token = reply.you.token;
    }
    return reply;
  }

  /** Index into `received`, for waiting only on frames that arrive after this point. */
  mark(): number {
    return this.received.length;
  }

  /**
   * Wait until a frame matching `predicate` arrives.
   * `since` skips frames already in the buffer — pass `mark()` when a test needs
   * the *next* occurrence rather than any historical one.
   */
  async waitFor<T extends ServerMessage = ServerMessage>(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    since = 0,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let index = since;
    for (;;) {
      while (index < this.received.length) {
        const message = this.received[index++]!;
        if (predicate(message)) return message as T;
      }
      if (Date.now() > deadline) {
        const seen = this.received.map((m) => m.t).join(', ');
        throw new Error(`timed out waiting for a frame; received: [${seen}]`);
      }
      await sleep(15);
    }
  }

  /** Wait for a specific game event kind. */
  async waitForEvent<K extends GameEvent['k']>(
    kind: K,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    since = 0,
  ): Promise<Extract<GameEvent, { k: K }>> {
    const message = await this.waitFor(
      (m) => m.t === 'event' && m.event.k === kind,
      timeoutMs,
      since,
    );
    if (message.t !== 'event') throw new Error('unreachable');
    return message.event as Extract<GameEvent, { k: K }>;
  }

  /** Wait until the newest state snapshot satisfies `predicate`. */
  async waitForState(
    predicate: (state: PublicState) => boolean,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<PublicState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const state = this.latestState();
      if (state && predicate(state)) return state;
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for state; last: ${JSON.stringify(this.latestState())}`);
      }
      await sleep(15);
    }
  }

  /** The most recent authoritative state this client has seen. */
  latestState(): PublicState | null {
    for (let i = this.received.length - 1; i >= 0; i--) {
      const message = this.received[i]!;
      if (message.t === 'welcome' || message.t === 'state' || message.t === 'event') {
        return message.state;
      }
    }
    return null;
  }

  state(): PublicState {
    const state = this.latestState();
    if (!state) throw new Error('no state received yet');
    return state;
  }

  eventKinds(): string[] {
    return this.received
      .filter((m) => m.t === 'event')
      .map((m) => (m.t === 'event' ? m.event.k : ''));
  }

  clear(): void {
    this.received.length = 0;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Open a room with `names.length` connected players. */
export async function openRoom(names: string[]): Promise<{ code: string; clients: TestClient[] }> {
  const code = await createRoom();
  const clients: TestClient[] = [];
  for (const name of names) {
    const client = new TestClient(code);
    await client.connect();
    const reply = await client.hello(name);
    if (reply.t !== 'welcome') throw new Error(`join failed for ${name}: ${JSON.stringify(reply)}`);
    clients.push(client);
  }
  // Everyone must see the full roster before a test starts making assertions.
  for (const client of clients) {
    await client.waitForState((s) => s.players.length === names.length);
  }
  return { code, clients };
}
