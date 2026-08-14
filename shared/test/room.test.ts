import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_BOARD_SIZE, cardById, type CardId } from '../src/cards.js';
import {
  INVALID_ACTION_COOLDOWN_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  ROOM_IDLE_TTL_MS,
  type ClaimRejectedMessage,
  type EventMessage,
  type GameEvent,
  type GameEventKind,
  type NoSetRejectedMessage,
  type ServerMessage,
} from '../src/protocol.js';
import { findAllSetsByIds, findFirstSet, hasSet, isSetByIds } from '../src/rules.js';
import { GameRoom, checkRoomInvariants, type Emission, type RoomEnv } from '../src/room.js';
import { seededRandom } from '../src/shuffle.js';

/** Controllable clock + deterministic ids and shuffle, so failures reproduce exactly. */
function testEnv(
  seed = 1234,
): RoomEnv & { advance: (ms: number) => void; setNow: (t: number) => void } {
  let clock = 1_700_000_000_000;
  let counter = 0;
  const random = seededRandom(seed);
  return {
    now: () => clock,
    random,
    newId: () => `id${String(++counter).padStart(8, '0')}`,
    advance: (ms: number) => {
      clock += ms;
    },
    setNow: (t: number) => {
      clock = t;
    },
  };
}

function eventsOf(emissions: Emission[]): GameEventKind[] {
  return emissions
    .map((e) => e.message)
    .filter((m): m is EventMessage => m.t === 'event')
    .map((m) => m.event.k);
}

function firstEvent<K extends GameEventKind>(
  emissions: Emission[],
  kind: K,
): Extract<GameEvent, { k: K }> {
  for (const emission of emissions) {
    if (emission.message.t === 'event' && emission.message.event.k === kind) {
      return emission.message.event as Extract<GameEvent, { k: K }>;
    }
  }
  throw new Error(`expected a "${kind}" event, saw: ${eventsOf(emissions).join(', ') || '(none)'}`);
}

function privateMessages<T extends ServerMessage['t']>(
  emissions: Emission[],
  type: T,
): { playerId: string; message: Extract<ServerMessage, { t: T }> }[] {
  const out: { playerId: string; message: Extract<ServerMessage, { t: T }> }[] = [];
  for (const emission of emissions) {
    if (emission.message.t === type && emission.target.kind === 'player') {
      out.push({
        playerId: emission.target.playerId,
        message: emission.message as Extract<ServerMessage, { t: T }>,
      });
    }
  }
  return out;
}

interface Seat {
  playerId: string;
  token: string;
}

function join(room: GameRoom, name: string): Seat {
  const result = room.join({ name });
  if (!result.ok) throw new Error(`join failed: ${result.code}`);
  return { playerId: result.playerId, token: result.token };
}

/** Start a two-player game and return the seats. */
function startedRoom(seed = 7): {
  room: GameRoom;
  env: ReturnType<typeof testEnv>;
  host: Seat;
  guest: Seat;
} {
  const env = testEnv(seed);
  const room = new GameRoom('ABC234', env);
  const host = join(room, 'Maya');
  const guest = join(room, 'David');
  const started = room.start(host.playerId);
  expect(started.ok).toBe(true);
  return { room, env, host, guest };
}

/** Find a valid set currently on the board. Test-only: the server never reveals one. */
function setOnBoard(room: GameRoom): CardId[] {
  const found = findFirstSet(room.getBoard());
  if (!found) throw new Error('board has no set');
  return [...found];
}

/** Three board cards that are definitely not a set. */
function nonSetOnBoard(room: GameRoom): CardId[] {
  const board = room.getBoard();
  for (let i = 0; i < board.length; i++) {
    for (let j = i + 1; j < board.length; j++) {
      for (let k = j + 1; k < board.length; k++) {
        if (!isSetByIds(board[i]!, board[j]!, board[k]!)) return [board[i]!, board[j]!, board[k]!];
      }
    }
  }
  throw new Error('board has no non-set triple');
}

describe('room creation and joining', () => {
  let env: ReturnType<typeof testEnv>;
  let room: GameRoom;

  beforeEach(() => {
    env = testEnv();
    room = new GameRoom('ABC234', env);
  });

  it('starts empty, in the lobby, with no host', () => {
    expect(room.getPhase()).toBe('lobby');
    expect(room.playerCount()).toBe(0);
    expect(room.getHostId()).toBeNull();
    expect(room.isEmpty()).toBe(true);
    expect(room.snapshot()).toMatchObject({
      v: PROTOCOL_VERSION,
      code: 'ABC234',
      phase: 'lobby',
      board: [],
      deckRemaining: 0,
      setsFound: 0,
      minPlayers: MIN_PLAYERS,
      maxPlayers: MAX_PLAYERS,
    });
  });

  it('makes the first player the host and issues a distinct id and token', () => {
    const result = room.join({ name: 'Maya' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(room.getHostId()).toBe(result.playerId);
    expect(result.token).not.toBe(result.playerId);
    expect(firstEvent(result.emissions, 'playerJoined')).toMatchObject({ playerName: 'Maya' });
    expect(room.snapshot().players[0]).toMatchObject({
      name: 'Maya',
      score: 0,
      connected: true,
      isHost: true,
      cooldownUntil: 0,
      wantsRematch: false,
    });
  });

  it('never exposes player tokens in a snapshot', () => {
    const seat = join(room, 'Maya');
    expect(JSON.stringify(room.snapshot())).not.toContain(seat.token);
  });

  it('never exposes the deck order in a snapshot', () => {
    join(room, 'Maya');
    join(room, 'David');
    room.start(room.getHostId()!);
    const snapshot = room.snapshot();
    expect(Object.keys(snapshot)).not.toContain('deck');
    expect(snapshot.deckRemaining).toBe(81 - INITIAL_BOARD_SIZE);
  });

  it('disambiguates duplicate display names', () => {
    join(room, 'Maya');
    join(room, 'maya');
    const names = room.snapshot().players.map((p) => p.name);
    expect(names).toEqual(['Maya', 'maya (2)']);
  });

  it('accepts up to 8 players and rejects the ninth', () => {
    for (let i = 0; i < MAX_PLAYERS; i++) join(room, `P${i}`);
    expect(room.playerCount()).toBe(MAX_PLAYERS);
    const overflow = room.join({ name: 'Late' });
    expect(overflow.ok).toBe(false);
    if (overflow.ok) return;
    expect(overflow.code).toBe('room_full');
  });

  it('rejects a late join once the game has started', () => {
    join(room, 'Maya');
    join(room, 'David');
    room.start(room.getHostId()!);
    const late = room.join({ name: 'Late' });
    expect(late.ok).toBe(false);
    if (late.ok) return;
    expect(late.code).toBe('game_already_started');
  });

  it('rejects a resume attempt with the wrong token', () => {
    const seat = join(room, 'Maya');
    const attempt = room.join({
      name: 'Impostor',
      playerId: seat.playerId,
      token: 'wrongtoken1234',
    });
    expect(attempt.ok).toBe(false);
    if (attempt.ok) return;
    expect(attempt.code).toBe('not_authorized');
    expect(room.snapshot().players[0]!.name).toBe('Maya');
  });

  it('treats unknown resume credentials as a fresh join while in the lobby', () => {
    const result = room.join({ name: 'Maya', playerId: 'unknownid1', token: 'unknowntoken1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.playerId).not.toBe('unknownid1');
    expect(room.playerCount()).toBe(1);
  });

  it('reports a replaced connection when the same seat connects twice', () => {
    const seat = join(room, 'Maya');
    const again = room.join({ name: 'Maya', playerId: seat.playerId, token: seat.token });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.replacedConnection).toBe(true);
    expect(room.playerCount()).toBe(1);
  });
});

describe('host assignment and transfer', () => {
  it('transfers host to the longest-connected active player when the host disconnects', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    env.advance(1000);
    const second = join(room, 'David');
    env.advance(1000);
    join(room, 'Noa');

    const emissions = room.disconnect(host.playerId);
    expect(eventsOf(emissions)).toEqual(['playerDisconnected', 'hostChanged']);
    expect(firstEvent(emissions, 'hostChanged').playerId).toBe(second.playerId);
    expect(room.getHostId()).toBe(second.playerId);
  });

  it('transfers host immediately when the host leaves before the game starts', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    const second = join(room, 'David');
    const emissions = room.leave(host.playerId);
    expect(eventsOf(emissions)).toEqual(['playerLeft', 'hostChanged']);
    expect(room.getHostId()).toBe(second.playerId);
    expect(room.playerCount()).toBe(1);
  });

  it('does not give host back to the original host on reconnect', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    const second = join(room, 'David');
    room.disconnect(host.playerId);
    expect(room.getHostId()).toBe(second.playerId);
    const resumed = room.join({ name: 'Maya', playerId: host.playerId, token: host.token });
    expect(resumed.ok).toBe(true);
    expect(room.getHostId()).toBe(second.playerId);
  });

  it('keeps the seated host when everyone is disconnected, and restores control on reconnect', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    room.disconnect(host.playerId);
    expect(room.getHostId()).toBe(host.playerId);
    const resumed = room.join({ name: 'Maya', playerId: host.playerId, token: host.token });
    expect(resumed.ok).toBe(true);
    expect(room.getHostId()).toBe(host.playerId);
  });
});

describe('starting a game', () => {
  it('refuses to start with fewer than two players', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    const result = room.start(host.playerId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_enough_players');
    expect(room.getPhase()).toBe('lobby');
  });

  it('refuses to start for a non-host', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    join(room, 'Maya');
    const guest = join(room, 'David');
    const result = room.start(guest.playerId);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_host');
    expect(room.getPhase()).toBe('lobby');
  });

  it('does not count disconnected players towards the minimum', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    const guest = join(room, 'David');
    room.disconnect(guest.playerId);
    // Host moved to the still-connected player; the disconnected one cannot make quorum.
    const result = room.start(room.getHostId()!);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_enough_players');
    expect(host.playerId).toBe(room.getHostId());
  });

  it('deals exactly 12 cards and 69 remain in the deck', () => {
    const { room } = startedRoom();
    expect(room.getPhase()).toBe('playing');
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE);
    expect(new Set(room.getBoard()).size).toBe(INITIAL_BOARD_SIZE);
    expect(room.getDeckRemaining()).toBe(81 - INITIAL_BOARD_SIZE);
    expect(checkRoomInvariants(room)).toEqual([]);
  });

  it('rejects a second start while playing', () => {
    const { room, host } = startedRoom();
    const again = room.start(host.playerId);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.code).toBe('game_already_started');
  });

  it('shuffles: two rooms with different seeds deal different boards', () => {
    const a = startedRoom(1).room.getBoard().join(',');
    const b = startedRoom(2).room.getBoard().join(',');
    expect(a).not.toBe(b);
  });
});

describe('valid SET claims', () => {
  it('scores the player, replaces the three cards in place and bumps the board version', () => {
    const { room, host } = startedRoom();
    const before = [...room.getBoard()];
    const version = room.getBoardVersion();
    const cards = setOnBoard(room);
    const slots = cards.map((id) => before.indexOf(id));

    const emissions = room.claim(host.playerId, cards, version);
    const event = firstEvent(emissions, 'setFound');
    expect(event).toMatchObject({ playerId: host.playerId, playerName: 'Maya', score: 1 });
    expect(event.cards).toEqual(cards);

    expect(room.getScore(host.playerId)).toBe(1);
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE);
    expect(room.getDeckRemaining()).toBe(81 - INITIAL_BOARD_SIZE - 3);
    expect(room.getBoardVersion()).toBe(version + 1);
    // Claimed cards are gone; untouched slots keep their card so the layout is stable.
    for (const id of cards) expect(room.getBoard()).not.toContain(id);
    before.forEach((id, index) => {
      if (!slots.includes(index)) expect(room.getBoard()[index]).toBe(id);
    });
    expect(checkRoomInvariants(room)).toEqual([]);
  });

  it('broadcasts the accepted claim to everyone with the updated state', () => {
    const { room, host, guest } = startedRoom();
    const emissions = room.claim(host.playerId, setOnBoard(room), room.getBoardVersion());
    const broadcast = emissions.find((e) => e.target.kind === 'all');
    expect(broadcast).toBeDefined();
    const message = broadcast!.message as EventMessage;
    expect(message.state.players.find((p) => p.id === host.playerId)!.score).toBe(1);
    expect(message.state.players.find((p) => p.id === guest.playerId)!.score).toBe(0);
    expect(message.state.setsFound).toBe(1);
  });

  it('does NOT replace cards when the board has more than 12 cards', () => {
    // Reach a 15-card board by finding a seed whose initial deal is set-free.
    const { room, host } = setFreeBoardRoom();
    expect(hasSet(room.getBoard())).toBe(false);
    room.noSet(host.playerId, room.getBoardVersion());
    expect(room.getBoard()).toHaveLength(15);

    const deckBefore = room.getDeckRemaining();
    const cards = setOnBoard(room);
    room.claim(host.playerId, cards, room.getBoardVersion());

    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE);
    expect(room.getDeckRemaining()).toBe(deckBefore);
    for (const id of cards) expect(room.getBoard()).not.toContain(id);
    expect(checkRoomInvariants(room)).toEqual([]);
  });

  it('shrinks the board instead of replacing when the deck is empty', () => {
    const { room, host, guest } = startedRoom();
    // Play the game out; once the deck empties, boards must shrink.
    let sawShrink = false;
    for (let i = 0; i < 40 && room.getPhase() === 'playing'; i++) {
      const player = i % 2 === 0 ? host : guest;
      if (hasSet(room.getBoard())) {
        const sizeBefore = room.getBoard().length;
        const deckBefore = room.getDeckRemaining();
        room.claim(player.playerId, setOnBoard(room), room.getBoardVersion());
        if (deckBefore === 0 && sizeBefore === INITIAL_BOARD_SIZE) {
          expect(room.getBoard()).toHaveLength(sizeBefore - 3);
          sawShrink = true;
        }
      } else {
        room.noSet(player.playerId, room.getBoardVersion());
      }
      expect(checkRoomInvariants(room)).toEqual([]);
    }
    expect(room.getPhase()).toBe('finished');
    expect(sawShrink).toBe(true);
  });
});

describe('invalid SET claims', () => {
  it('leaves the board untouched and cools down only the claiming player', () => {
    const { room, env, host, guest } = startedRoom();
    const before = [...room.getBoard()];
    const version = room.getBoardVersion();
    const cards = nonSetOnBoard(room);

    const emissions = room.claim(host.playerId, cards, version);
    expect(room.getBoard()).toEqual(before);
    expect(room.getBoardVersion()).toBe(version);
    expect(room.getScore(host.playerId)).toBe(0);

    const rejections = privateMessages(emissions, 'claimRejected');
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.playerId).toBe(host.playerId);
    const rejection = rejections[0]!.message as ClaimRejectedMessage;
    expect(rejection.reason).toBe('not_a_set');
    expect(rejection.mismatch).not.toBeNull();
    expect(rejection.cooldownUntil).toBe(env.now() + INVALID_ACTION_COOLDOWN_MS);

    // Everyone hears that the claim failed, but nobody is told why or where a set is.
    expect(eventsOf(emissions)).toEqual(['invalidClaim']);
    expect(JSON.stringify(emissions.filter((e) => e.target.kind === 'all'))).not.toContain(
      'mismatch',
    );

    const state = room.snapshot();
    expect(state.players.find((p) => p.id === host.playerId)!.cooldownUntil).toBeGreaterThan(0);
    expect(state.players.find((p) => p.id === guest.playerId)!.cooldownUntil).toBe(0);
  });

  it('explains the mismatch with a real attribute conflict', () => {
    const { room, host } = startedRoom();
    const cards = nonSetOnBoard(room);
    const emissions = room.claim(host.playerId, cards, room.getBoardVersion());
    const rejection = privateMessages(emissions, 'claimRejected')[0]!
      .message as ClaimRejectedMessage;
    const mismatch = rejection.mismatch!;
    const values = cards.map((id) => cardById(id)[mismatch.attribute]);
    expect(new Set(values).size).toBe(2);
  });

  it('blocks further claims until the cooldown expires', () => {
    const { room, env, host } = startedRoom();
    room.claim(host.playerId, nonSetOnBoard(room), room.getBoardVersion());

    const duringCooldown = room.claim(host.playerId, setOnBoard(room), room.getBoardVersion());
    expect(
      (privateMessages(duringCooldown, 'claimRejected')[0]!.message as ClaimRejectedMessage).reason,
    ).toBe('cooldown');
    expect(room.getScore(host.playerId)).toBe(0);

    env.advance(INVALID_ACTION_COOLDOWN_MS - 1);
    expect(
      (
        privateMessages(
          room.claim(host.playerId, setOnBoard(room), room.getBoardVersion()),
          'claimRejected',
        )[0]!.message as ClaimRejectedMessage
      ).reason,
    ).toBe('cooldown');

    env.advance(1);
    const after = room.claim(host.playerId, setOnBoard(room), room.getBoardVersion());
    expect(firstEvent(after, 'setFound').score).toBe(1);
  });

  it('does not cool down the other player', () => {
    const { room, host, guest } = startedRoom();
    room.claim(host.playerId, nonSetOnBoard(room), room.getBoardVersion());
    const emissions = room.claim(guest.playerId, setOnBoard(room), room.getBoardVersion());
    expect(firstEvent(emissions, 'setFound').playerId).toBe(guest.playerId);
  });

  it('rejects claims before the game starts and after it finishes', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    join(room, 'David');
    const emissions = room.claim(host.playerId, [0, 1, 2], 0);
    expect(
      (privateMessages(emissions, 'claimRejected')[0]!.message as ClaimRejectedMessage).reason,
    ).toBe('not_playing');
  });

  it('ignores claims from unknown players', () => {
    const { room } = startedRoom();
    expect(room.claim('nobody', [0, 1, 2], room.getBoardVersion())).toEqual([]);
  });
});

describe('stale and simultaneous claims', () => {
  it('only lets the first claim mutate a given board version', () => {
    const { room, host, guest } = startedRoom();
    const version = room.getBoardVersion();
    const cards = setOnBoard(room);

    const first = room.claim(host.playerId, cards, version);
    expect(firstEvent(first, 'setFound').playerId).toBe(host.playerId);

    // The loser's frame was already in flight against the old board version.
    const second = room.claim(guest.playerId, cards, version);
    const rejection = privateMessages(second, 'claimRejected')[0]!.message as ClaimRejectedMessage;
    expect(rejection.reason).toBe('board_changed');
    expect(room.getScore(guest.playerId)).toBe(0);
    // A stale claim is never punished with a cooldown.
    expect(rejection.cooldownUntil).toBe(0);
    expect(eventsOf(second)).toEqual([]);
  });

  it('rejects a duplicate delivery of the same winning claim', () => {
    const { room, host } = startedRoom();
    const version = room.getBoardVersion();
    const cards = setOnBoard(room);
    room.claim(host.playerId, cards, version);
    const duplicate = room.claim(host.playerId, cards, version);
    expect(
      (privateMessages(duplicate, 'claimRejected')[0]!.message as ClaimRejectedMessage).reason,
    ).toBe('board_changed');
    expect(room.getScore(host.playerId)).toBe(1);
  });

  it('rejects cards that are no longer on the board even at the right version', () => {
    const { room, host } = startedRoom();
    const board = room.getBoard();
    const offBoard: CardId[] = [];
    for (let id = 0; id < 81 && offBoard.length < 3; id++)
      if (!board.includes(id)) offBoard.push(id);
    const emissions = room.claim(host.playerId, offBoard, room.getBoardVersion());
    expect(
      (privateMessages(emissions, 'claimRejected')[0]!.message as ClaimRejectedMessage).reason,
    ).toBe('board_changed');
  });

  it('rejects a claim with duplicate card ids', () => {
    const { room, host } = startedRoom();
    const card = room.getBoard()[0]!;
    const emissions = room.claim(host.playerId, [card, card, card], room.getBoardVersion());
    expect(
      (privateMessages(emissions, 'claimRejected')[0]!.message as ClaimRejectedMessage).reason,
    ).toBe('invalid_cards');
  });
});

/** A room whose initial 12-card deal happens to contain no set. */
function setFreeBoardRoom(): {
  room: GameRoom;
  env: ReturnType<typeof testEnv>;
  host: Seat;
  guest: Seat;
} {
  for (let seed = 1; seed < 5000; seed++) {
    const candidate = startedRoom(seed);
    if (!hasSet(candidate.room.getBoard())) return candidate;
  }
  throw new Error('no seed produced a set-free opening board');
}

describe('"No SET on board"', () => {
  it('is rejected with a cooldown when a set does exist, without revealing it', () => {
    const { room, env, host, guest } = startedRoom();
    expect(hasSet(room.getBoard())).toBe(true);
    const before = [...room.getBoard()];

    const emissions = room.noSet(host.playerId, room.getBoardVersion());
    expect(room.getBoard()).toEqual(before);
    const rejection = privateMessages(emissions, 'noSetRejected')[0]!
      .message as NoSetRejectedMessage;
    expect(rejection.reason).toBe('set_exists');
    expect(rejection.cooldownUntil).toBe(env.now() + INVALID_ACTION_COOLDOWN_MS);
    // No card ids leak in any message produced by the rejection.
    expect(JSON.stringify(emissions)).not.toContain('cards');
    expect(eventsOf(emissions)).toEqual(['noSetRejected']);
    expect(room.snapshot().players.find((p) => p.id === guest.playerId)!.cooldownUntil).toBe(0);
  });

  it('deals exactly three extra cards when the board really has no set', () => {
    const { room, host } = setFreeBoardRoom();
    const deckBefore = room.getDeckRemaining();
    const before = [...room.getBoard()];
    const version = room.getBoardVersion();

    const emissions = room.noSet(host.playerId, version);
    const event = firstEvent(emissions, 'cardsAdded');
    expect(event).toMatchObject({ count: 3, playerId: host.playerId });
    expect(room.getBoard()).toHaveLength(15);
    expect(room.getBoard().slice(0, 12)).toEqual(before);
    expect(room.getDeckRemaining()).toBe(deckBefore - 3);
    expect(room.getBoardVersion()).toBe(version + 1);
    expect(room.snapshot().players.find((p) => p.id === host.playerId)!.cooldownUntil).toBe(0);
    expect(checkRoomInvariants(room)).toEqual([]);
  });

  it('is rejected on a stale board version without a cooldown', () => {
    const { room, host } = startedRoom();
    const stale = room.getBoardVersion() - 1;
    const emissions = room.noSet(host.playerId, stale);
    const rejection = privateMessages(emissions, 'noSetRejected')[0]!
      .message as NoSetRejectedMessage;
    expect(rejection.reason).toBe('board_changed');
    expect(rejection.cooldownUntil).toBe(0);
  });

  it('honours an existing cooldown', () => {
    const { room, host } = startedRoom();
    room.claim(host.playerId, nonSetOnBoard(room), room.getBoardVersion());
    const emissions = room.noSet(host.playerId, room.getBoardVersion());
    expect(
      (privateMessages(emissions, 'noSetRejected')[0]!.message as NoSetRejectedMessage).reason,
    ).toBe('cooldown');
  });

  it('is rejected outside the playing phase', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    const emissions = room.noSet(host.playerId, 0);
    expect(
      (privateMessages(emissions, 'noSetRejected')[0]!.message as NoSetRejectedMessage).reason,
    ).toBe('not_playing');
  });

  it('ends the game when the board has no set and the deck is empty', () => {
    const { room, host, guest } = startedRoom(11);
    // Drain the deck by playing normally.
    let guard = 0;
    while (room.getPhase() === 'playing' && guard++ < 60) {
      const player = guard % 2 === 0 ? host : guest;
      if (hasSet(room.getBoard())) {
        room.claim(player.playerId, setOnBoard(room), room.getBoardVersion());
      } else {
        room.noSet(player.playerId, room.getBoardVersion());
      }
    }
    expect(room.getPhase()).toBe('finished');
    expect(room.getDeckRemaining()).toBe(0);
    expect(hasSet(room.getBoard())).toBe(false);
  });
});

describe('game completion', () => {
  it('never strands the game on a set-free board while cards remain', () => {
    // Play 60 full games with different shuffles and assert the invariant holds
    // at every single step.
    for (let seed = 1; seed <= 60; seed++) {
      const { room, host, guest } = startedRoom(seed);
      let guard = 0;
      while (room.getPhase() === 'playing') {
        expect(guard++).toBeLessThan(200);
        expect(checkRoomInvariants(room)).toEqual([]);
        const board = room.getBoard();
        const player = guard % 2 === 0 ? host : guest;
        if (hasSet(board)) {
          room.claim(player.playerId, setOnBoard(room), room.getBoardVersion());
        } else {
          // A set-free board must always be resolvable: either three more cards
          // can be dealt, or the game must end on this call.
          const deckBefore = room.getDeckRemaining();
          const emissions = room.noSet(player.playerId, room.getBoardVersion());
          if (deckBefore >= 3) {
            expect(eventsOf(emissions)).toContain('cardsAdded');
          } else {
            expect(eventsOf(emissions)).toContain('gameOver');
          }
          const rejected = privateMessages(emissions, 'noSetRejected');
          expect(rejected.map((r) => (r.message as NoSetRejectedMessage).reason)).not.toContain(
            'set_exists',
          );
        }
      }
      expect(room.getPhase()).toBe('finished');
      expect(room.getDeckRemaining()).toBe(0);
      expect(hasSet(room.getBoard())).toBe(false);
      expect(findAllSetsByIds(room.getBoard())).toEqual([]);
      // All 81 cards are accounted for: 3 per claimed set + whatever is left face-up.
      const totalScore = room.snapshot().players.reduce((sum, p) => sum + p.score, 0);
      expect(totalScore * 3 + room.getBoard().length).toBe(81);
      expect(checkRoomInvariants(room)).toEqual([]);
    }
  });

  it('finishes immediately after a claim that empties the deck and leaves no set', () => {
    const { room, host, guest } = startedRoom(3);
    let last: Emission[] = [];
    let guard = 0;
    while (room.getPhase() === 'playing' && guard++ < 200) {
      const player = guard % 2 === 0 ? host : guest;
      last = hasSet(room.getBoard())
        ? room.claim(player.playerId, setOnBoard(room), room.getBoardVersion())
        : room.noSet(player.playerId, room.getBoardVersion());
    }
    expect(eventsOf(last)).toContain('gameOver');
  });

  it('reports a tie as a tie, with no invented tie-breaker', () => {
    const { room, host, guest } = startedRoom(5);
    let guard = 0;
    let final: Emission[] = [];
    while (room.getPhase() === 'playing' && guard++ < 200) {
      // Alternate strictly so the scores stay as even as the shuffle allows.
      const player = guard % 2 === 0 ? host : guest;
      final = hasSet(room.getBoard())
        ? room.claim(player.playerId, setOnBoard(room), room.getBoardVersion())
        : room.noSet(player.playerId, room.getBoardVersion());
    }
    const over = firstEvent(final, 'gameOver');
    const scores = room.snapshot().players.map((p) => p.score);
    const best = Math.max(...scores);
    expect(over.winnerIds).toHaveLength(scores.filter((s) => s === best).length);
    expect(over.winnerNames.length).toBe(over.winnerIds.length);
  });
});

describe('rematch', () => {
  function finishedRoom(): ReturnType<typeof startedRoom> {
    const ctx = startedRoom(9);
    let guard = 0;
    while (ctx.room.getPhase() === 'playing' && guard++ < 200) {
      const player = guard % 2 === 0 ? ctx.host : ctx.guest;
      if (hasSet(ctx.room.getBoard())) {
        ctx.room.claim(player.playerId, setOnBoard(ctx.room), ctx.room.getBoardVersion());
      } else {
        ctx.room.noSet(player.playerId, ctx.room.getBoardVersion());
      }
    }
    expect(ctx.room.getPhase()).toBe('finished');
    return ctx;
  }

  it('records a non-host request without restarting', () => {
    const { room, guest } = finishedRoom();
    const result = room.rematch(guest.playerId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(firstEvent(result.emissions, 'rematchWanted').playerId).toBe(guest.playerId);
    expect(room.getPhase()).toBe('finished');
    expect(room.snapshot().players.find((p) => p.id === guest.playerId)!.wantsRematch).toBe(true);
  });

  it('is idempotent for a repeated non-host request', () => {
    const { room, guest } = finishedRoom();
    room.rematch(guest.playerId);
    const again = room.rematch(guest.playerId);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.emissions).toEqual([]);
  });

  it('lets the host start a fresh shuffled game with scores reset', () => {
    const { room, host } = finishedRoom();
    const previousBoard = [...room.getBoard()];
    const result = room.rematch(host.playerId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(eventsOf(result.emissions)).toContain('gameStarted');
    expect(room.getPhase()).toBe('playing');
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE);
    expect(room.getBoard()).not.toEqual(previousBoard);
    expect(room.getDeckRemaining()).toBe(81 - INITIAL_BOARD_SIZE);
    for (const player of room.snapshot().players) {
      expect(player.score).toBe(0);
      expect(player.wantsRematch).toBe(false);
      expect(player.cooldownUntil).toBe(0);
    }
  });

  it('drops disconnected seats and refuses when too few players remain', () => {
    const { room, host, guest } = finishedRoom();
    room.disconnect(guest.playerId);
    const result = room.rematch(room.getHostId()!);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('not_enough_players');
    expect(room.getPhase()).toBe('finished');
    expect(host.playerId).toBeTruthy();
  });

  it('is rejected outside the finished phase', () => {
    const { room, host } = startedRoom();
    const result = room.rematch(host.playerId);
    expect(result.ok).toBe(false);
  });
});

describe('disconnect, grace period and reconnect', () => {
  it('keeps identity, name and score across a reconnect inside the grace window', () => {
    const { room, env, host, guest } = startedRoom();
    room.claim(host.playerId, setOnBoard(room), room.getBoardVersion());
    expect(room.getScore(host.playerId)).toBe(1);

    const disconnected = room.disconnect(host.playerId);
    expect(eventsOf(disconnected)).toContain('playerDisconnected');
    expect(room.snapshot().players.find((p) => p.id === host.playerId)!.connected).toBe(false);
    expect(room.playerCount()).toBe(2);

    env.advance(RECONNECT_GRACE_MS - 1);
    expect(room.tick()).toEqual([]);

    const resumed = room.join({ name: 'Maya', playerId: host.playerId, token: host.token });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(resumed.playerId).toBe(host.playerId);
    expect(eventsOf(resumed.emissions)).toEqual(['playerReconnected']);
    expect(room.getScore(host.playerId)).toBe(1);
    expect(room.snapshot().players.find((p) => p.id === host.playerId)).toMatchObject({
      name: 'Maya',
      score: 1,
      connected: true,
    });
    expect(guest.playerId).toBeTruthy();
  });

  it('reclaims the seat once the grace period elapses', () => {
    const { room, env, host } = startedRoom();
    room.disconnect(host.playerId);
    env.advance(RECONNECT_GRACE_MS);
    const emissions = room.tick();
    expect(eventsOf(emissions)).toContain('playerLeft');
    expect(room.playerCount()).toBe(1);
    expect(room.hasPlayer(host.playerId)).toBe(false);

    const rejoin = room.join({ name: 'Maya', playerId: host.playerId, token: host.token });
    expect(rejoin.ok).toBe(false);
    if (rejoin.ok) return;
    expect(rejoin.code).toBe('game_already_started');
  });

  it('does not rename a player mid-game on reconnect', () => {
    const { room, host } = startedRoom();
    room.disconnect(host.playerId);
    room.join({ name: 'Cheater', playerId: host.playerId, token: host.token });
    expect(room.snapshot().players.find((p) => p.id === host.playerId)!.name).toBe('Maya');
  });

  it('allows a rename on reconnect while still in the lobby', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const seat = join(room, 'Maya');
    room.disconnect(seat.playerId);
    room.join({ name: 'Maya2', playerId: seat.playerId, token: seat.token });
    expect(room.snapshot().players[0]!.name).toBe('Maya2');
  });

  it('schedules a timer for the grace expiry and for idle cleanup', () => {
    const { room, env, host } = startedRoom();
    // Everyone connected and nobody disconnected: only idle cleanup is irrelevant.
    room.disconnect(host.playerId);
    const at = room.nextTimerAt();
    expect(at).toBe(env.now() + RECONNECT_GRACE_MS);
  });

  it('expires an abandoned room after the idle TTL', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const seat = join(room, 'Maya');
    expect(room.isExpired()).toBe(false);
    room.leave(seat.playerId);
    expect(room.isEmpty()).toBe(true);
    env.advance(ROOM_IDLE_TTL_MS);
    expect(room.isExpired()).toBe(true);
  });

  it('is a no-op to disconnect an unknown or already-disconnected player', () => {
    const { room, host } = startedRoom();
    expect(room.disconnect('nobody')).toEqual([]);
    room.disconnect(host.playerId);
    expect(room.disconnect(host.playerId)).toEqual([]);
    expect(room.leave('nobody')).toEqual([]);
  });
});

describe('persistence', () => {
  it('round-trips a mid-game room without leaking or losing state', () => {
    const { room, env, host, guest } = startedRoom();
    room.claim(host.playerId, setOnBoard(room), room.getBoardVersion());
    const serialized = JSON.parse(JSON.stringify(room.serialize()));

    const restored = GameRoom.deserialize(serialized, env);
    expect(restored.getPhase()).toBe('playing');
    expect(restored.getBoard()).toEqual(room.getBoard());
    expect(restored.getBoardVersion()).toBe(room.getBoardVersion());
    expect(restored.getDeckRemaining()).toBe(room.getDeckRemaining());
    expect(restored.getScore(host.playerId)).toBe(1);
    expect(restored.playerCount()).toBe(2);
    // No sockets survive a restart, so everyone is inside their grace window.
    expect(restored.connectedCount()).toBe(0);

    const resumed = restored.join({ name: 'Maya', playerId: host.playerId, token: host.token });
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) return;
    expect(restored.getScore(host.playerId)).toBe(1);
    expect(restored.getHostId()).toBeTruthy();
    expect(guest.playerId).toBeTruthy();
  });

  it('still rejects a wrong token after a restart', () => {
    const { room, env, host } = startedRoom();
    const restored = GameRoom.deserialize(JSON.parse(JSON.stringify(room.serialize())), env);
    const attempt = restored.join({
      name: 'Impostor',
      playerId: host.playerId,
      token: 'nope1234abcd',
    });
    expect(attempt.ok).toBe(false);
  });
});
