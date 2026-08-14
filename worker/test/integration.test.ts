/**
 * Integration tests for the Worker + Durable Object, against a live workerd.
 *
 * These cover the transport layer that the pure `GameRoom` tests cannot: real
 * sockets, seat/token authentication, fan-out, rate limiting, malformed frames,
 * host succession on socket loss and reconnect identity.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  INITIAL_BOARD_SIZE,
  MAX_MESSAGE_BYTES,
  MAX_BOARD_SIZE,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  findFirstSet,
  hasSet,
  isSetByIds,
  type CardId,
  type ClaimRejectedMessage,
  type PublicState,
} from '@set/shared';
import { BASE_URL, TestClient, WS_URL, createRoom, openRoom, roomInfo, sleep } from './harness.js';

const openClients: TestClient[] = [];

function track<T extends TestClient>(client: T): T {
  openClients.push(client);
  return client;
}

afterEach(() => {
  for (const client of openClients.splice(0)) client.close();
});

async function room(names: string[]): Promise<{ code: string; clients: TestClient[] }> {
  const result = await openRoom(names);
  for (const client of result.clients) track(client);
  return result;
}

/** A valid set on the current board. Tests may look; the server never tells. */
function setOn(state: PublicState): CardId[] {
  const found = findFirstSet(state.board);
  if (!found) throw new Error('no set on board');
  return [...found];
}

function nonSetOn(state: PublicState): CardId[] {
  const { board } = state;
  for (let i = 0; i < board.length; i++) {
    for (let j = i + 1; j < board.length; j++) {
      for (let k = j + 1; k < board.length; k++) {
        if (!isSetByIds(board[i]!, board[j]!, board[k]!)) return [board[i]!, board[j]!, board[k]!];
      }
    }
  }
  throw new Error('no non-set triple on board');
}

/** Start a game and return both clients once everyone sees `playing`. */
async function playing(): Promise<{ code: string; host: TestClient; guest: TestClient }> {
  const { code, clients } = await room(['Maya', 'David']);
  const [host, guest] = clients as [TestClient, TestClient];
  host.send({ t: 'start' });
  for (const client of [host, guest]) {
    await client.waitForState(
      (s) => s.phase === 'playing' && s.board.length === INITIAL_BOARD_SIZE,
    );
  }
  return { code, host, guest };
}

/**
 * Start games until the opening board satisfies `predicate`.
 *
 * Roughly 1 deal in 30 contains no set, so tests that depend on either shape of
 * board must select for it rather than assume it — otherwise they are flaky.
 */
async function playingWhere(
  predicate: (board: readonly CardId[]) => boolean,
  attempts = 250,
): Promise<{ code: string; host: TestClient; guest: TestClient }> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const game = await playing();
    if (predicate(game.host.state().board)) return game;
    game.host.close();
    game.guest.close();
  }
  throw new Error(`no opening board matched the predicate in ${attempts} attempts`);
}

describe('HTTP surface', () => {
  it('reports health and the protocol version', async () => {
    const response = await fetch(`${BASE_URL}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, protocol: PROTOCOL_VERSION });
  });

  it('mints a room code from the safe alphabet', async () => {
    const code = await createRoom();
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('mints distinct codes', async () => {
    const codes = await Promise.all([createRoom(), createRoom(), createRoom(), createRoom()]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('reports a created room as joinable and an unknown one as missing', async () => {
    const code = await createRoom();
    const created = await roomInfo(code);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ exists: true, phase: 'lobby', players: 0, canJoin: true });

    const missing = await roomInfo('ZZZZZZ');
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ exists: false });
  });

  it('rejects malformed room codes', async () => {
    const bad = await roomInfo('AB!23');
    expect(bad.status).toBe(400);
  });

  it('returns 404 for unknown paths and 426 for a non-upgrade socket path', async () => {
    expect((await fetch(`${BASE_URL}/nope`)).status).toBe(404);
    const code = await createRoom();
    expect((await fetch(`${BASE_URL}/api/rooms/${code}/ws`)).status).toBe(426);
  });

  it('refuses a WebSocket to a room that was never created', async () => {
    const socket = new WebSocket(`${WS_URL}/api/rooms/ZZZZZZ/ws`);
    const outcome = await new Promise<string>((resolve) => {
      socket.addEventListener('open', () => resolve('open'), { once: true });
      socket.addEventListener('error', () => resolve('error'), { once: true });
      socket.addEventListener('close', () => resolve('close'), { once: true });
    });
    expect(outcome).not.toBe('open');
    socket.close();
  });

  it('blocks a disallowed browser origin', async () => {
    const response = await fetch(`${BASE_URL}/api/rooms`, {
      method: 'POST',
      headers: { Origin: 'https://not-allowed.example' },
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'origin_not_allowed' });
  });

  it('allows a localhost origin and echoes it back for CORS', async () => {
    const response = await fetch(`${BASE_URL}/api/rooms`, {
      method: 'POST',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(response.status).toBe(201);
    expect(response.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    expect(response.headers.get('vary')).toBe('Origin');
  });

  it('answers a CORS preflight', async () => {
    const response = await fetch(`${BASE_URL}/api/rooms`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('joining a room', () => {
  it('welcomes the first player as host and issues a private seat token', async () => {
    const { clients } = await room(['Maya']);
    const [host] = clients as [TestClient];
    const state = host.state();
    expect(state.players).toHaveLength(1);
    expect(state.players[0]).toMatchObject({
      name: 'Maya',
      isHost: true,
      score: 0,
      connected: true,
    });
    expect(host.token).toMatch(/^[0-9a-f]{32}$/);
    expect(host.playerId).not.toBe(host.token);
  });

  it('never sends another player their token', async () => {
    const { clients } = await room(['Maya', 'David']);
    const [host, guest] = clients as [TestClient, TestClient];
    expect(JSON.stringify(guest.received)).not.toContain(host.token);
    expect(JSON.stringify(host.received)).not.toContain(guest.token);
  });

  it('tells everyone when a player joins', async () => {
    const { code, clients } = await room(['Maya']);
    const [host] = clients as [TestClient];
    const mark = host.mark();
    const joiner = track(new TestClient(code));
    await joiner.connect();
    await joiner.hello('David');
    const event = await host.waitForEvent('playerJoined', 5_000, mark);
    expect(event.playerName).toBe('David');
    await host.waitForState((s) => s.players.length === 2);
  });

  it('rejects a ninth player', async () => {
    const names = Array.from({ length: MAX_PLAYERS }, (_unused, i) => `P${i}`);
    const { code } = await room(names);
    const late = track(new TestClient(code));
    await late.connect();
    const reply = await late.hello('Overflow');
    expect(reply).toMatchObject({ t: 'error', code: 'room_full', fatal: true });
  });

  it('rejects a late join once the game is playing', async () => {
    const { code } = await playing();
    const late = track(new TestClient(code));
    await late.connect();
    const reply = await late.hello('Late');
    expect(reply).toMatchObject({ t: 'error', code: 'game_already_started', fatal: true });
  });

  it('rejects a mismatched protocol version and says to reload', async () => {
    const code = await createRoom();
    const client = track(new TestClient(code));
    await client.connect();
    client.send({ t: 'hello', v: 999, name: 'Maya' });
    const reply = await client.waitFor((m) => m.t === 'error');
    expect(reply).toMatchObject({ t: 'error', code: 'protocol_version_mismatch', fatal: true });
    if (reply.t === 'error') expect(reply.message.toLowerCase()).toContain('reload');
  });

  it('refuses to act before saying hello', async () => {
    const code = await createRoom();
    const client = track(new TestClient(code));
    await client.connect();
    client.send({ t: 'start' });
    const reply = await client.waitFor((m) => m.t === 'error');
    expect(reply).toMatchObject({ t: 'error', code: 'not_authorized' });
  });
});

describe('impersonation and authorisation', () => {
  it('rejects a resume attempt with the wrong token', async () => {
    const { code, clients } = await room(['Maya']);
    const [host] = clients as [TestClient];
    const impostor = track(new TestClient(code));
    await impostor.connect();
    const reply = await impostor.hello('Impostor', {
      playerId: host.playerId,
      token: 'deadbeefdeadbeefdeadbeefdeadbeef',
    });
    expect(reply).toMatchObject({ t: 'error', code: 'not_authorized' });
    // The real player keeps their seat and name.
    expect(host.state().players[0]!.name).toBe('Maya');
  });

  it('refuses a non-host start', async () => {
    const { clients } = await room(['Maya', 'David']);
    const [, guest] = clients as [TestClient, TestClient];
    guest.send({ t: 'start' });
    const reply = await guest.waitFor((m) => m.t === 'error');
    expect(reply).toMatchObject({ t: 'error', code: 'not_host', fatal: false });
    expect(guest.state().phase).toBe('lobby');
  });

  it('refuses to start a one-player game', async () => {
    const { clients } = await room(['Maya']);
    const [host] = clients as [TestClient];
    host.send({ t: 'start' });
    const reply = await host.waitFor((m) => m.t === 'error');
    expect(reply).toMatchObject({ t: 'error', code: 'not_enough_players' });
  });
});

describe('malformed input and abuse', () => {
  it('rejects malformed JSON without dropping the connection', async () => {
    const { clients } = await room(['Maya', 'David']);
    const [host] = clients as [TestClient];
    host.sendRaw('{not json');
    const reply = await host.waitFor((m) => m.t === 'error');
    expect(reply).toMatchObject({ t: 'error', code: 'invalid_message', fatal: false });
    // The socket is still usable afterwards.
    host.send({ t: 'ping' });
    await host.waitFor((m) => m.t === 'pong');
  });

  it('rejects unknown message types and bad payload shapes', async () => {
    const { clients } = await room(['Maya', 'David']);
    const [host] = clients as [TestClient];
    for (const payload of [
      '{"t":"shutdown"}',
      '{"t":"claim","cards":[1,2],"boardVersion":0}',
      '{"t":"claim","cards":[1,2,99],"boardVersion":0}',
      '{"t":"noSet"}',
      '[]',
    ]) {
      host.clear();
      host.sendRaw(payload);
      const reply = await host.waitFor((m) => m.t === 'error');
      expect(reply).toMatchObject({ code: 'invalid_message' });
    }
  });

  it('rejects an oversized frame', async () => {
    const { clients } = await room(['Maya', 'David']);
    const [host] = clients as [TestClient];
    host.sendRaw(JSON.stringify({ t: 'ping', pad: 'x'.repeat(MAX_MESSAGE_BYTES * 2) }));
    const reply = await host.waitFor((m) => m.t === 'error');
    expect(reply).toMatchObject({ code: 'invalid_message' });
  });

  it('disconnects a socket that floods the room', async () => {
    const { clients } = await room(['Maya', 'David']);
    const [host] = clients as [TestClient];
    for (let i = 0; i < 80; i++) host.send({ t: 'ping' });
    await host.waitFor((m) => m.t === 'error' && m.fatal);
    await sleep(150);
    expect(host.closeCode).not.toBeNull();
  });

  it('keeps the room healthy for other players after one misbehaves', async () => {
    const { code, clients } = await room(['Maya', 'David']);
    const [host, guest] = clients as [TestClient, TestClient];
    for (let i = 0; i < 80; i++) guest.send({ t: 'ping' });
    await guest.waitFor((m) => m.t === 'error' && m.fatal);
    // Maya is still connected and the room still works.
    host.send({ t: 'ping' });
    await host.waitFor((m) => m.t === 'pong');
    expect(code).toBeTruthy();
  });
});

describe('gameplay over the wire', () => {
  it('deals 12 cards to everyone identically', async () => {
    const { host, guest } = await playing();
    expect(host.state().board).toEqual(guest.state().board);
    expect(host.state().board).toHaveLength(INITIAL_BOARD_SIZE);
    expect(host.state().deckRemaining).toBe(69);
    expect(new Set(host.state().board).size).toBe(INITIAL_BOARD_SIZE);
  });

  it('broadcasts an accepted claim, the score and the new board to both players', async () => {
    const { host, guest } = await playing();
    const state = host.state();
    const cards = setOn(state);
    host.send({ t: 'claim', cards, boardVersion: state.boardVersion });

    for (const client of [host, guest]) {
      const event = await client.waitForEvent('setFound');
      expect(event).toMatchObject({ playerId: host.playerId, playerName: 'Maya', score: 1 });
      expect(event.cards).toEqual(cards);
      const updated = await client.waitForState((s) => s.setsFound === 1);
      expect(updated.players.find((p) => p.id === host.playerId)!.score).toBe(1);
      expect(updated.players.find((p) => p.id === guest.playerId)!.score).toBe(0);
      expect(updated.board).toHaveLength(INITIAL_BOARD_SIZE);
      for (const id of cards) expect(updated.board).not.toContain(id);
      expect(updated.boardVersion).toBe(state.boardVersion + 1);
    }
    expect(host.state().board).toEqual(guest.state().board);
  });

  it('privately explains an invalid claim and cools down only that player', async () => {
    const { host, guest } = await playing();
    const state = host.state();
    const cards = nonSetOn(state);
    host.send({ t: 'claim', cards, boardVersion: state.boardVersion });

    const rejection = await host.waitFor<ClaimRejectedMessage>((m) => m.t === 'claimRejected');
    expect(rejection.reason).toBe('not_a_set');
    expect(rejection.mismatch).not.toBeNull();
    expect(rejection.cooldownUntil).toBeGreaterThan(rejection.serverTime);

    // The other player learns that a claim failed, but not why.
    await guest.waitForEvent('invalidClaim');
    expect(guest.received.some((m) => m.t === 'claimRejected')).toBe(false);
    expect(JSON.stringify(guest.received)).not.toContain('mismatch');

    const after = await guest.waitForState((s) => s.players.some((p) => p.cooldownUntil > 0));
    expect(after.players.find((p) => p.id === host.playerId)!.cooldownUntil).toBeGreaterThan(0);
    expect(after.players.find((p) => p.id === guest.playerId)!.cooldownUntil).toBe(0);
    expect(after.board).toEqual(state.board);
    expect(after.boardVersion).toBe(state.boardVersion);
  });

  it('lets exactly one of two simultaneous claims win', async () => {
    const { host, guest } = await playing();
    const state = host.state();
    const cards = setOn(state);
    // Both frames are put on the wire before either is processed.
    host.send({ t: 'claim', cards, boardVersion: state.boardVersion });
    guest.send({ t: 'claim', cards, boardVersion: state.boardVersion });

    const winner = await host.waitForEvent('setFound');
    const loser = winner.playerId === host.playerId ? guest : host;
    const rejection = await loser.waitFor<ClaimRejectedMessage>((m) => m.t === 'claimRejected');
    expect(rejection.reason).toBe('board_changed');
    // The loser is not punished for losing a race.
    expect(rejection.cooldownUntil).toBe(0);

    const finalState = await guest.waitForState((s) => s.setsFound === 1);
    const scores = finalState.players.map((p) => p.score).sort();
    expect(scores).toEqual([0, 1]);
  });

  it('rejects a stale claim referring to cards that are gone', async () => {
    const { host, guest } = await playing();
    const state = host.state();
    const cards = setOn(state);
    host.send({ t: 'claim', cards, boardVersion: state.boardVersion });
    await guest.waitForEvent('setFound');
    // Guest replays the old claim against the old version.
    guest.send({ t: 'claim', cards, boardVersion: state.boardVersion });
    const rejection = await guest.waitFor<ClaimRejectedMessage>((m) => m.t === 'claimRejected');
    expect(rejection.reason).toBe('board_changed');
  });

  it('rejects "no SET" when a set exists, without revealing it', async () => {
    const { host, guest } = await playingWhere(hasSet);
    const state = host.state();
    expect(hasSet(state.board)).toBe(true);
    host.send({ t: 'noSet', boardVersion: state.boardVersion });

    const rejection = await host.waitFor((m) => m.t === 'noSetRejected');
    expect(rejection).toMatchObject({ reason: 'set_exists' });
    await guest.waitForEvent('noSetRejected');
    // Board unchanged, and no card list was disclosed anywhere.
    expect(guest.state().board).toEqual(state.board);
    expect(guest.state().boardVersion).toBe(state.boardVersion);
  });

  it('deals three more cards when the board genuinely has no set', async () => {
    const { host, guest } = await playingWhere((board) => !hasSet(board));
    const state = host.state();
    host.send({ t: 'noSet', boardVersion: state.boardVersion });

    const event = await guest.waitForEvent('cardsAdded');
    expect(event).toMatchObject({ count: 3, playerName: 'Maya' });
    const updated = await guest.waitForState((s) => s.board.length === 15);
    // The existing twelve keep their slots, so nothing moves under the players.
    expect(updated.board.slice(0, 12)).toEqual(state.board);
    expect(updated.deckRemaining).toBe(state.deckRemaining - 3);
    expect(updated.players.every((p) => p.cooldownUntil === 0)).toBe(true);
  }, 180_000);

  it('does not replace claimed cards while the board is larger than twelve', async () => {
    const { host, guest } = await playingWhere((board) => !hasSet(board));
    host.send({ t: 'noSet', boardVersion: host.state().boardVersion });
    const grown = await host.waitForState((s) => s.board.length === 15);
    expect(hasSet(grown.board)).toBe(true);

    const cards = setOn(grown);
    host.send({ t: 'claim', cards, boardVersion: grown.boardVersion });
    const shrunk = await guest.waitForState((s) => s.board.length === INITIAL_BOARD_SIZE);
    expect(shrunk.deckRemaining).toBe(grown.deckRemaining);
    for (const id of cards) expect(shrunk.board).not.toContain(id);
  }, 180_000);

  it('plays a full game to completion and supports a rematch', async () => {
    const { host, guest } = await playing();
    let turn = 0;
    while (host.state().phase === 'playing') {
      expect(turn++).toBeLessThan(120);
      const actor = turn % 2 === 0 ? host : guest;
      const state = actor.state();
      if (hasSet(state.board)) {
        const cards = setOn(state);
        actor.send({ t: 'claim', cards, boardVersion: state.boardVersion });
        await actor.waitForState((s) => s.boardVersion > state.boardVersion);
      } else {
        actor.send({ t: 'noSet', boardVersion: state.boardVersion });
        await actor.waitForState(
          (s) => s.boardVersion > state.boardVersion || s.phase === 'finished',
        );
      }
    }

    const final = await guest.waitForState((s) => s.phase === 'finished');
    expect(final.deckRemaining).toBe(0);
    expect(hasSet(final.board)).toBe(false);
    const totalScore = final.players.reduce((sum, p) => sum + p.score, 0);
    expect(totalScore * 3 + final.board.length).toBe(81);
    const over = await guest.waitForEvent('gameOver');
    const best = Math.max(...final.players.map((p) => p.score));
    expect(over.winnerIds).toHaveLength(final.players.filter((p) => p.score === best).length);

    // Non-host vote does not restart the game.
    guest.send({ t: 'rematch' });
    const wanted = await host.waitForEvent('rematchWanted');
    expect(wanted.playerId).toBe(guest.playerId);
    expect(host.state().phase).toBe('finished');

    // Host restarts, scores reset.
    host.send({ t: 'rematch' });
    const restarted = await guest.waitForState((s) => s.phase === 'playing');
    expect(restarted.board).toHaveLength(INITIAL_BOARD_SIZE);
    expect(restarted.deckRemaining).toBe(69);
    expect(restarted.players.every((p) => p.score === 0 && !p.wantsRematch)).toBe(true);
  }, 120_000);
});

describe('disconnect, host succession and reconnect', () => {
  it('marks a dropped player disconnected and hands the host role over', async () => {
    const { clients } = await room(['Maya', 'David', 'Noa']);
    const [host, second, third] = clients as [TestClient, TestClient, TestClient];
    expect(host.state().players.find((p) => p.id === host.playerId)!.isHost).toBe(true);

    host.close();
    const event = await second.waitForEvent('hostChanged');
    expect(event.playerId).toBe(second.playerId);
    const state = await third.waitForState((s) => s.players.some((p) => !p.connected));
    expect(state.players.find((p) => p.id === host.playerId)).toMatchObject({
      connected: false,
      name: 'Maya',
    });
    expect(state.players.find((p) => p.id === second.playerId)!.isHost).toBe(true);
  });

  it('restores identity, name and score on reconnect inside the grace period', async () => {
    const { code, host, guest } = await playing();
    const state = host.state();
    host.send({ t: 'claim', cards: setOn(state), boardVersion: state.boardVersion });
    await host.waitForEvent('setFound');
    const seat = { playerId: host.playerId, token: host.token };

    host.close();
    await guest.waitForEvent('playerDisconnected');

    const resumed = track(new TestClient(code));
    await resumed.connect();
    const welcome = await resumed.hello('Maya', seat);
    expect(welcome.t).toBe('welcome');
    expect(resumed.playerId).toBe(seat.playerId);
    const resumedState = resumed.state();
    expect(resumedState.phase).toBe('playing');
    expect(resumedState.players.find((p) => p.id === seat.playerId)).toMatchObject({
      name: 'Maya',
      score: 1,
      connected: true,
    });
    // The resumed client sees the same authoritative board as the player who stayed.
    expect(resumedState.board).toEqual(guest.state().board);
    await guest.waitForEvent('playerReconnected');
  });

  it('replaces an earlier socket when the same seat connects twice', async () => {
    const { code, clients } = await room(['Maya', 'David']);
    const [host] = clients as [TestClient, TestClient];
    const seat = { playerId: host.playerId, token: host.token };

    const second = track(new TestClient(code));
    await second.connect();
    const welcome = await second.hello('Maya', seat);
    expect(welcome.t).toBe('welcome');
    await sleep(200);
    // The original socket was closed rather than left as a second voice.
    expect(host.closeCode).not.toBeNull();
    expect(second.state().players).toHaveLength(2);
  });

  it('removes a player who leaves explicitly', async () => {
    const { clients } = await room(['Maya', 'David']);
    const [host, guest] = clients as [TestClient, TestClient];
    guest.send({ t: 'leave' });
    const event = await host.waitForEvent('playerLeft');
    expect(event.playerId).toBe(guest.playerId);
    await host.waitForState((s) => s.players.length === 1);
  });

  it('keeps the room usable after everyone reconnects', async () => {
    const { code, host, guest } = await playing();
    const hostSeat = { playerId: host.playerId, token: host.token };
    host.close();
    await guest.waitForEvent('playerDisconnected');

    const resumed = track(new TestClient(code));
    await resumed.connect();
    await resumed.hello('Maya', hostSeat);
    const state = resumed.state();
    const cards = setOn(state);
    resumed.send({ t: 'claim', cards, boardVersion: state.boardVersion });
    const event = await guest.waitForEvent('setFound');
    expect(event.playerId).toBe(hostSeat.playerId);
  });
});

describe('dealing more cards by agreement, over the wire', () => {
  it('waits for the whole table, then deals three cards to everyone', async () => {
    const { host, guest } = await playing();
    const state = host.state();

    host.send({ t: 'deal', want: true, boardVersion: state.boardVersion });
    const asked = await guest.waitForEvent('dealVote');
    expect(asked).toMatchObject({ playerName: 'Maya', want: true, votes: 1, needed: 2 });
    // One player is not enough: the board must be untouched.
    expect(guest.state().board).toEqual(state.board);
    expect(guest.state().dealVotes).toEqual([host.playerId]);

    guest.send({ t: 'deal', want: true, boardVersion: state.boardVersion });
    const added = await host.waitForEvent('cardsAdded');
    expect(added).toMatchObject({ count: 3, reason: 'agreed' });
    for (const client of [host, guest]) {
      const grown = await client.waitForState((s) => s.board.length === INITIAL_BOARD_SIZE + 3);
      expect(grown.board.slice(0, INITIAL_BOARD_SIZE)).toEqual(state.board);
      expect(grown.deckRemaining).toBe(state.deckRemaining - 3);
      expect(grown.dealVotes).toEqual([]);
      expect(grown.players.every((p) => p.cooldownUntil === 0)).toBe(true);
    }
  });

  it('lets a player withdraw, and tells the table', async () => {
    const { host, guest } = await playing();
    const version = host.state().boardVersion;
    host.send({ t: 'deal', want: true, boardVersion: version });
    await guest.waitForEvent('dealVote');

    const since = guest.mark();
    host.send({ t: 'deal', want: false, boardVersion: version });
    const withdrawn = await guest.waitForEvent('dealVote', 5_000, since);
    expect(withdrawn).toMatchObject({ want: false, votes: 0 });
    expect(guest.state().dealVotes).toEqual([]);
    expect(guest.state().board).toHaveLength(INITIAL_BOARD_SIZE);
  });

  it('cancels an open request when somebody claims a set instead', async () => {
    const { host, guest } = await playingWhere(hasSet);
    const state = host.state();
    host.send({ t: 'deal', want: true, boardVersion: state.boardVersion });
    await guest.waitForState((s) => s.dealVotes.length === 1);

    guest.send({ t: 'claim', cards: setOn(state), boardVersion: state.boardVersion });
    const after = await host.waitForState((s) => s.boardVersion !== state.boardVersion);
    expect(after.dealVotes).toEqual([]);
    expect(after.dealVoteExpiresAt).toBe(0);
    expect(after.board).toHaveLength(INITIAL_BOARD_SIZE);
  });

  it('refuses to grow the board past the cap', async () => {
    const { host, guest } = await playing();
    for (let size = INITIAL_BOARD_SIZE; size < MAX_BOARD_SIZE; size += 3) {
      const version = host.state().boardVersion;
      host.send({ t: 'deal', want: true, boardVersion: version });
      guest.send({ t: 'deal', want: true, boardVersion: version });
      await host.waitForState((s) => s.board.length === size + 3);
    }
    host.send({ t: 'deal', want: true, boardVersion: host.state().boardVersion });
    const rejection = await host.waitFor((m) => m.t === 'dealRejected');
    expect(rejection).toMatchObject({ reason: 'board_full' });
    expect(host.state().board).toHaveLength(MAX_BOARD_SIZE);
  }, 180_000);
});

describe('hints, over the wire', () => {
  it('is locked at the start of a board, and says when it opens', async () => {
    const { host, guest } = await playing();
    const state = host.state();
    const since = guest.mark();

    host.send({ t: 'hint', level: 1, boardVersion: state.boardVersion });
    const rejection = await host.waitFor((m) => m.t === 'hintRejected');
    expect(rejection).toMatchObject({ reason: 'too_soon' });
    if (rejection.t !== 'hintRejected') throw new Error('unreachable');
    expect(rejection.availableAt - rejection.serverTime).toBeGreaterThan(50_000);

    // A locked hint is not an event: the other player is told nothing at all.
    await sleep(150);
    expect(guest.received.slice(since).some((m) => m.t === 'event')).toBe(false);
    expect(guest.received.some((m) => m.t === 'hintRejected')).toBe(false);
  });

  it('rejects a hint asked about a board that has already changed', async () => {
    const { host, guest } = await playingWhere(hasSet);
    const state = host.state();
    guest.send({ t: 'claim', cards: setOn(state), boardVersion: state.boardVersion });
    await host.waitForState((s) => s.boardVersion !== state.boardVersion);

    host.send({ t: 'hint', level: 2, boardVersion: state.boardVersion });
    expect(await host.waitFor((m) => m.t === 'hintRejected')).toMatchObject({
      reason: 'board_changed',
    });
  });

  it('validates the level before it reaches the room', async () => {
    const { host } = await playing();
    host.sendRaw(JSON.stringify({ t: 'hint', level: 3, boardVersion: host.state().boardVersion }));
    const error = await host.waitFor((m) => m.t === 'error');
    expect(error).toMatchObject({ code: 'invalid_message', fatal: false });
    // The room is still perfectly usable afterwards.
    host.send({ t: 'hint', level: 1, boardVersion: host.state().boardVersion });
    expect(await host.waitFor((m) => m.t === 'hintRejected')).toMatchObject({ reason: 'too_soon' });
  });

  it('never puts the hint clock or a set into the public snapshot', async () => {
    const { host } = await playing();
    const state = host.state();
    expect(typeof state.boardSince).toBe('number');
    expect(Object.keys(state)).not.toContain('deck');
    // `boardSince` is a timestamp, not a hint: it says when the board appeared.
    expect(state.boardSince).toBeLessThanOrEqual(state.serverTime);
  });
});
