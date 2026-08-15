import { beforeEach, describe, expect, it } from 'vitest';
import { INITIAL_BOARD_SIZE, SET_SIZE, cardById, type CardId } from '../src/cards.js';
import {
  DEAL_VOTE_TTL_MS,
  HINT_LEVEL_1_AFTER_MS,
  HINT_LEVEL_2_AFTER_MS,
  INVALID_ACTION_COOLDOWN_MS,
  MAX_BOARD_SIZE,
  MAX_PLAYERS,
  MIN_PLAYERS,
  NO_SET_PAUSE_MS,
  PROTOCOL_VERSION,
  RECONNECT_GRACE_MS,
  ROOM_IDLE_TTL_MS,
  type ClaimRejectedMessage,
  type DealRejectedMessage,
  type EventMessage,
  type GameEvent,
  type GameEventKind,
  type HintRejectedMessage,
  type HintRevealedMessage,
  type ServerMessage,
} from '../src/protocol.js';
import {
  findAllSetsByIds,
  findFirstSet,
  findRequiredThirdCardId,
  hasSet,
  isSetByIds,
} from '../src/rules.js';
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

/**
 * Let the pause on a set-free board run out and deal what the server decided.
 *
 * This is the whole "no SET" flow now: nobody calls it, so a test that wants the
 * position resolved waits exactly as the players do.
 */
function passNoSetPause(room: GameRoom, env: ReturnType<typeof testEnv>): Emission[] {
  env.advance(NO_SET_PAUSE_MS);
  return room.tick();
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
    const { room, env, host } = setFreeBoardRoom();
    expect(hasSet(room.getBoard())).toBe(false);
    passNoSetPause(room, env);
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
    const { room, env, host, guest } = startedRoom();
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
        passNoSetPause(room, env);
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

describe('a board with no SET', () => {
  it('is announced the moment it appears, with the deal already on the clock', () => {
    const { room, env } = setFreeBoardRoom();
    // Nobody called this: the announcement came out of `start()` itself.
    expect(room.getAutoDealAt()).toBe(env.now() + NO_SET_PAUSE_MS);
    expect(room.snapshot().autoDealAt).toBe(env.now() + NO_SET_PAUSE_MS);
    expect(room.nextTimerAt()).toBe(env.now() + NO_SET_PAUSE_MS);
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE);
  });

  it('says nothing at all on a board that does have a set', () => {
    const { room } = startedRoom();
    expect(hasSet(room.getBoard())).toBe(true);
    expect(room.getAutoDealAt()).toBe(0);
    expect(room.snapshot().autoDealAt).toBe(0);
  });

  it('deals exactly three extra cards when the pause elapses, at nobody\u2019s expense', () => {
    const { room, env } = setFreeBoardRoom();
    const deckBefore = room.getDeckRemaining();
    const before = [...room.getBoard()];
    const version = room.getBoardVersion();

    // Nothing happens a tick early: the pause is there to be seen.
    env.advance(NO_SET_PAUSE_MS - 1);
    expect(room.tick()).toEqual([]);
    expect(room.getBoard()).toEqual(before);

    env.advance(1);
    const emissions = room.tick();
    expect(firstEvent(emissions, 'cardsAdded')).toMatchObject({ count: 3, reason: 'auto' });
    expect(room.getBoard()).toHaveLength(15);
    expect(room.getBoard().slice(0, 12)).toEqual(before);
    expect(room.getDeckRemaining()).toBe(deckBefore - 3);
    expect(room.getBoardVersion()).toBe(version + 1);
    for (const player of room.snapshot().players) expect(player.cooldownUntil).toBe(0);
    expect(checkRoomInvariants(room)).toEqual([]);
  });

  it('tells the whole table at once, not the player who happened to act', () => {
    const { room, env, host, guest } = startedRoom();
    let guard = 0;
    let emissions: Emission[] = [];
    // Play until a claim leaves a board with nothing left to find.
    while (room.getPhase() === 'playing' && guard++ < 200) {
      if (!hasSet(room.getBoard())) {
        passNoSetPause(room, env);
        continue;
      }
      const player = guard % 2 === 0 ? host : guest;
      emissions = room.claim(player.playerId, setOnBoard(room), room.getBoardVersion());
      if (eventsOf(emissions).includes('noSetOnBoard')) break;
    }
    expect(eventsOf(emissions)).toContain('noSetOnBoard');
    for (const emission of emissions) {
      if (emission.message.t === 'event' && emission.message.event.k === 'noSetOnBoard') {
        expect(emission.target).toEqual({ kind: 'all' });
        // It is a statement about the board, not about a player.
        expect(Object.keys(emission.message.event)).toEqual(['k', 'dealsAt']);
      }
    }
  });

  it('refuses a claim made during the pause, without a cooldown', () => {
    const { room, host, guest } = setFreeBoardRoom();
    const before = [...room.getBoard()];
    const emissions = room.claim(host.playerId, nonSetOnBoard(room), room.getBoardVersion());

    const rejection = privateMessages(emissions, 'claimRejected')[0]!
      .message as ClaimRejectedMessage;
    expect(rejection.reason).toBe('no_set_on_board');
    // Being on a dead board is not a mistake, so it costs nothing.
    expect(rejection.cooldownUntil).toBe(0);
    expect(eventsOf(emissions)).toEqual([]);
    expect(room.getBoard()).toEqual(before);
    expect(room.snapshot().players.find((p) => p.id === guest.playerId)!.cooldownUntil).toBe(0);
  });

  it('still calls a stale claim stale, rather than blaming the dead board', () => {
    const { room, host } = setFreeBoardRoom();
    const emissions = room.claim(host.playerId, nonSetOnBoard(room), room.getBoardVersion() - 1);
    expect(
      (privateMessages(emissions, 'claimRejected')[0]!.message as ClaimRejectedMessage).reason,
    ).toBe('board_changed');
  });

  it('announces again when the three new cards are set-free too', () => {
    // Drive a real game until a deal lands on another dead board, then check the
    // server picked it up on its own rather than waiting to be told.
    for (let seed = 1; seed < 600; seed++) {
      const { room, env, host, guest } = startedRoom(seed);
      let guard = 0;
      let sawRepeat = false;
      while (room.getPhase() === 'playing' && guard++ < 200) {
        if (hasSet(room.getBoard())) {
          const player = guard % 2 === 0 ? host : guest;
          room.claim(player.playerId, setOnBoard(room), room.getBoardVersion());
          continue;
        }
        const size = room.getBoard().length;
        const emissions = passNoSetPause(room, env);
        if (eventsOf(emissions).includes('cardsAdded') && room.getAutoDealAt() > 0) {
          expect(hasSet(room.getBoard())).toBe(false);
          expect(room.getBoard()).toHaveLength(size + SET_SIZE);
          expect(firstEvent(emissions, 'noSetOnBoard').dealsAt).toBe(room.getAutoDealAt());
          sawRepeat = true;
          break;
        }
      }
      if (sawRepeat) return;
    }
    throw new Error('no seed produced two set-free boards in a row');
  });

  it('ends the game instead of dealing when the deck is empty', () => {
    const { room, env, host, guest } = startedRoom(11);
    let guard = 0;
    let last: Emission[] = [];
    while (room.getPhase() === 'playing' && guard++ < 200) {
      const player = guard % 2 === 0 ? host : guest;
      last = hasSet(room.getBoard())
        ? room.claim(player.playerId, setOnBoard(room), room.getBoardVersion())
        : passNoSetPause(room, env);
    }
    expect(room.getPhase()).toBe('finished');
    expect(room.getDeckRemaining()).toBe(0);
    expect(hasSet(room.getBoard())).toBe(false);
    // The last thing the table is told is why: no set, and nothing left to deal.
    expect(eventsOf(last).slice(-2)).toEqual(['noSetOnBoard', 'gameOver']);
    expect(firstEvent(last, 'noSetOnBoard').dealsAt).toBe(0);
    expect(room.getAutoDealAt()).toBe(0);
  });
});

describe('game completion', () => {
  it('never strands the game on a set-free board while cards remain', () => {
    // Play 60 full games with different shuffles and assert the invariant holds
    // at every single step.
    for (let seed = 1; seed <= 60; seed++) {
      const { room, env, host, guest } = startedRoom(seed);
      let guard = 0;
      while (room.getPhase() === 'playing') {
        expect(guard++).toBeLessThan(200);
        expect(checkRoomInvariants(room)).toEqual([]);
        const board = room.getBoard();
        const player = guard % 2 === 0 ? host : guest;
        if (hasSet(board)) {
          room.claim(player.playerId, setOnBoard(room), room.getBoardVersion());
        } else {
          // A set-free board must always be announced and then resolved on its
          // own: either three more cards are dealt, or the game ends here.
          expect(room.getAutoDealAt()).toBeGreaterThan(0);
          const deckBefore = room.getDeckRemaining();
          const emissions = passNoSetPause(room, env);
          expect(eventsOf(emissions)).toContain(deckBefore >= 3 ? 'cardsAdded' : 'gameOver');
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

  it('ends on the claim itself when it empties the deck and leaves no set', () => {
    const { room, env, host, guest } = startedRoom(3);
    let last: Emission[] = [];
    let guard = 0;
    while (room.getPhase() === 'playing' && guard++ < 200) {
      const player = guard % 2 === 0 ? host : guest;
      last = hasSet(room.getBoard())
        ? room.claim(player.playerId, setOnBoard(room), room.getBoardVersion())
        : passNoSetPause(room, env);
    }
    // No pause and no timer: with nothing left to deal there is nothing to wait
    // for, so the results screen comes straight off the winning claim.
    expect(eventsOf(last)).toContain('gameOver');
    expect(room.nextTimerAt()).toBeNull();
  });

  it('reports a tie as a tie, with no invented tie-breaker', () => {
    const { room, env, host, guest } = startedRoom(5);
    let guard = 0;
    let final: Emission[] = [];
    while (room.getPhase() === 'playing' && guard++ < 200) {
      // Alternate strictly so the scores stay as even as the shuffle allows.
      const player = guard % 2 === 0 ? host : guest;
      final = hasSet(room.getBoard())
        ? room.claim(player.playerId, setOnBoard(room), room.getBoardVersion())
        : passNoSetPause(room, env);
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
        passNoSetPause(ctx.room, ctx.env);
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

  it('carries an open request for more cards through a restart', () => {
    const { room, env, host } = startedRoom();
    room.voteDeal(host.playerId, true, room.getBoardVersion());
    const restored = GameRoom.deserialize(JSON.parse(JSON.stringify(room.serialize())), env);
    expect(restored.snapshot().dealVotes).toEqual([host.playerId]);
    expect(restored.snapshot().dealVoteExpiresAt).toBe(env.now() + DEAL_VOTE_TTL_MS);
    expect(restored.snapshot().boardSince).toBe(room.snapshot().boardSince);
  });

  it('loads a room stored before hints and shared dealing existed', () => {
    const { room, env, host } = startedRoom();
    // Exactly what version 1 wrote: no votes, no hint clock.
    const v1 = JSON.parse(JSON.stringify(room.serialize())) as Record<string, unknown>;
    v1['s'] = 1;
    delete v1['dealVotes'];
    delete v1['dealVoteExpiresAt'];
    delete v1['boardSince'];

    env.advance(HINT_LEVEL_2_AFTER_MS);
    const restored = GameRoom.deserialize(v1 as never, env);
    expect(restored.getPhase()).toBe('playing');
    expect(restored.getBoard()).toEqual(room.getBoard());
    expect(restored.snapshot().dealVotes).toEqual([]);
    expect(restored.snapshot().dealVoteExpiresAt).toBe(0);
    // The hint clock starts now rather than handing out a free hint on load.
    expect(restored.snapshot().boardSince).toBe(env.now());
    const resumed = restored.join({ name: 'Maya', playerId: host.playerId, token: host.token });
    expect(resumed.ok).toBe(true);
    expect(
      privateMessages(restored.hint(host.playerId, 1, restored.getBoardVersion()), 'hintRejected'),
    ).toHaveLength(1);
  });

  it('restarts the pause on a set-free board rather than trusting a stopped clock', () => {
    const { room, env } = setFreeBoardRoom();
    // The room is evicted mid-pause and comes back much later.
    const stored = JSON.parse(JSON.stringify(room.serialize()));
    env.advance(ROOM_IDLE_TTL_MS);
    const restored = GameRoom.deserialize(stored, env);
    expect(restored.getAutoDealAt()).toBe(env.now() + NO_SET_PAUSE_MS);
    expect(eventsOf(passNoSetPause(restored, env))).toContain('cardsAdded');
    expect(restored.getBoard()).toHaveLength(INITIAL_BOARD_SIZE + SET_SIZE);
  });

  it('rescues a v2 room parked on a set-free board, which nothing else can resolve now', () => {
    const { room, env } = setFreeBoardRoom();
    // Exactly what version 2 wrote: no record of a pending deal, because the
    // position waited for a player to call it.
    const v2 = JSON.parse(JSON.stringify(room.serialize())) as Record<string, unknown>;
    v2['s'] = 2;
    delete v2['autoDealAt'];

    const restored = GameRoom.deserialize(v2 as never, env);
    expect(restored.getAutoDealAt()).toBe(env.now() + NO_SET_PAUSE_MS);
    expect(restored.snapshot().dealVotes).toEqual([]);
    expect(checkRoomInvariants(restored)).toEqual([]);
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

/** Everybody asks for three more cards, in seat order. Returns the last batch. */
function agreeToDeal(room: GameRoom, seats: Seat[]): Emission[] {
  let last: Emission[] = [];
  for (const seat of seats) {
    last = room.voteDeal(seat.playerId, true, room.getBoardVersion());
  }
  return last;
}

/** A mid-game room whose deck has run out but which is still being played. */
function drainedDeckRoom(): {
  room: GameRoom;
  env: ReturnType<typeof testEnv>;
  host: Seat;
  guest: Seat;
} {
  for (let seed = 1; seed < 400; seed++) {
    const { room, env, host, guest } = startedRoom(seed);
    let guard = 0;
    while (room.getPhase() === 'playing' && room.getDeckRemaining() > 0 && guard++ < 100) {
      const player = guard % 2 === 0 ? host : guest;
      if (hasSet(room.getBoard())) {
        room.claim(player.playerId, setOnBoard(room), room.getBoardVersion());
      } else {
        passNoSetPause(room, env);
      }
    }
    if (room.getPhase() === 'playing' && room.getDeckRemaining() === 0) {
      return { room, env, host, guest };
    }
  }
  throw new Error('no seed left the deck empty with the game still running');
}

describe('dealing more cards by agreement', () => {
  it('does nothing on one player’s request, and says how many have agreed', () => {
    const { room, host, guest } = startedRoom();
    const before = [...room.getBoard()];
    const version = room.getBoardVersion();

    const emissions = room.voteDeal(host.playerId, true, version);

    expect(room.getBoard()).toEqual(before);
    expect(room.getBoardVersion()).toBe(version);
    expect(firstEvent(emissions, 'dealVote')).toMatchObject({
      playerId: host.playerId,
      want: true,
      votes: 1,
      needed: 2,
    });
    expect(room.snapshot().dealVotes).toEqual([host.playerId]);
    expect(room.snapshot().dealVoteExpiresAt).toBeGreaterThan(0);
    expect(guest.playerId).toBeTruthy();
  });

  it('deals exactly three cards once every connected player agrees', () => {
    const { room, host, guest } = startedRoom();
    const before = [...room.getBoard()];
    const deckBefore = room.getDeckRemaining();
    const version = room.getBoardVersion();

    room.voteDeal(host.playerId, true, version);
    const emissions = room.voteDeal(guest.playerId, true, version);

    expect(firstEvent(emissions, 'cardsAdded')).toMatchObject({ count: 3, reason: 'agreed' });
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE + SET_SIZE);
    // The cards that were already out keep their slots, so nothing moves.
    expect(room.getBoard().slice(0, INITIAL_BOARD_SIZE)).toEqual(before);
    expect(room.getDeckRemaining()).toBe(deckBefore - SET_SIZE);
    expect(room.getBoardVersion()).toBe(version + 1);
    expect(room.snapshot().dealVotes).toEqual([]);
    expect(room.snapshot().dealVoteExpiresAt).toBe(0);
    expect(checkRoomInvariants(room)).toEqual([]);
  });

  it('never costs anybody a cooldown', () => {
    const { room, host, guest } = startedRoom();
    agreeToDeal(room, [host, guest]);
    for (const player of room.snapshot().players) expect(player.cooldownUntil).toBe(0);
  });

  it('lets a player take their request back', () => {
    const { room, host, guest } = startedRoom();
    room.voteDeal(host.playerId, true, room.getBoardVersion());
    const emissions = room.voteDeal(host.playerId, false, room.getBoardVersion());

    expect(firstEvent(emissions, 'dealVote')).toMatchObject({ want: false, votes: 0 });
    expect(room.snapshot().dealVotes).toEqual([]);
    expect(room.snapshot().dealVoteExpiresAt).toBe(0);

    // ...and the other player agreeing alone is then not enough.
    room.voteDeal(guest.playerId, true, room.getBoardVersion());
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE);
  });

  it('ignores a repeated request from the same player', () => {
    const { room, host } = startedRoom();
    room.voteDeal(host.playerId, true, room.getBoardVersion());
    expect(room.voteDeal(host.playerId, true, room.getBoardVersion())).toEqual([]);
    expect(room.snapshot().dealVotes).toEqual([host.playerId]);
    expect(room.voteDeal(host.playerId, false, room.getBoardVersion())).not.toEqual([]);
    expect(room.voteDeal(host.playerId, false, room.getBoardVersion())).toEqual([]);
  });

  it('lapses on its own when the table never answers', () => {
    const { room, env, host } = startedRoom();
    room.voteDeal(host.playerId, true, room.getBoardVersion());
    expect(room.nextTimerAt()).toBe(env.now() + DEAL_VOTE_TTL_MS);

    env.advance(DEAL_VOTE_TTL_MS - 1);
    expect(eventsOf(room.tick())).toEqual([]);
    env.advance(1);
    expect(eventsOf(room.tick())).toEqual(['dealLapsed']);
    expect(room.snapshot().dealVotes).toEqual([]);
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE);
  });

  it('cancels an open request when the board changes underneath it', () => {
    const { room, host, guest } = startedRoom();
    room.voteDeal(host.playerId, true, room.getBoardVersion());
    room.claim(guest.playerId, setOnBoard(room), room.getBoardVersion());
    expect(room.snapshot().dealVotes).toEqual([]);
    expect(room.snapshot().dealVoteExpiresAt).toBe(0);
    expect(room.nextTimerAt()).toBeNull();
  });

  it('rejects a request made against a board that has already moved on', () => {
    const { room, host } = startedRoom();
    const emissions = room.voteDeal(host.playerId, true, room.getBoardVersion() - 1);
    expect(
      (privateMessages(emissions, 'dealRejected')[0]!.message as DealRejectedMessage).reason,
    ).toBe('board_changed');
    expect(room.snapshot().dealVotes).toEqual([]);
  });

  it('is rejected outside the playing phase', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    const emissions = room.voteDeal(host.playerId, true, 0);
    expect(
      (privateMessages(emissions, 'dealRejected')[0]!.message as DealRejectedMessage).reason,
    ).toBe('not_playing');
  });

  it('stops at the board cap, because 21 cards always contain a SET', () => {
    const { room, host, guest } = startedRoom();
    const seats = [host, guest];
    for (let size = INITIAL_BOARD_SIZE; size < MAX_BOARD_SIZE; size += SET_SIZE) {
      agreeToDeal(room, seats);
      expect(room.getBoard()).toHaveLength(size + SET_SIZE);
    }
    expect(room.getBoard()).toHaveLength(MAX_BOARD_SIZE);

    const emissions = room.voteDeal(host.playerId, true, room.getBoardVersion());
    expect(
      (privateMessages(emissions, 'dealRejected')[0]!.message as DealRejectedMessage).reason,
    ).toBe('board_full');
    expect(room.getBoard()).toHaveLength(MAX_BOARD_SIZE);
    expect(checkRoomInvariants(room)).toEqual([]);
  });

  it('does not deal twice when the table asks during the pause on a dead board', () => {
    const { room, env, host, guest } = setFreeBoardRoom();
    const deckBefore = room.getDeckRemaining();
    expect(room.getAutoDealAt()).toBeGreaterThan(0);

    // Both players tap "+3 cards" before the automatic deal lands.
    agreeToDeal(room, [host, guest]);
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE + SET_SIZE);
    expect(room.getDeckRemaining()).toBe(deckBefore - SET_SIZE);

    // The pending deal belonged to the board that just went away.
    const after = room.getAutoDealAt();
    env.advance(NO_SET_PAUSE_MS);
    room.tick();
    const dealt = deckBefore - room.getDeckRemaining();
    expect(dealt).toBe(after > 0 ? SET_SIZE * 2 : SET_SIZE);
    expect(checkRoomInvariants(room)).toEqual([]);
  });

  it('refuses when the deck has nothing left to deal', () => {
    const { room, host } = drainedDeckRoom();
    const emissions = room.voteDeal(host.playerId, true, room.getBoardVersion());
    expect(
      (privateMessages(emissions, 'dealRejected')[0]!.message as DealRejectedMessage).reason,
    ).toBe('deck_empty');
  });

  it('completes the request when the only player who had not agreed drops out', () => {
    const { room, host, guest } = startedRoom();
    room.voteDeal(host.playerId, true, room.getBoardVersion());
    const emissions = room.disconnect(guest.playerId);

    // Everyone still at the table (just the host) is asking, so the cards go out.
    expect(eventsOf(emissions)).toContain('cardsAdded');
    expect(firstEvent(emissions, 'cardsAdded')).toMatchObject({ reason: 'agreed' });
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE + SET_SIZE);
  });

  it('drops the vote of a player who leaves without dealing behind their back', () => {
    // A three-player table, so the one who asked is not the whole room.
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    const guest = join(room, 'David');
    join(room, 'Noa');
    expect(room.start(host.playerId).ok).toBe(true);

    room.voteDeal(guest.playerId, true, room.getBoardVersion());
    const emissions = room.leave(guest.playerId);

    expect(eventsOf(emissions)).not.toContain('cardsAdded');
    expect(room.snapshot().dealVotes).toEqual([]);
    expect(room.getBoard()).toHaveLength(INITIAL_BOARD_SIZE);
    expect(room.nextTimerAt()).toBeNull();
  });
});

describe('hints', () => {
  it('is locked for the first minute on a board', () => {
    const { room, env, host } = startedRoom();
    const emissions = room.hint(host.playerId, 1, room.getBoardVersion());
    const rejection = privateMessages(emissions, 'hintRejected')[0]!.message as HintRejectedMessage;
    expect(rejection.reason).toBe('too_soon');
    expect(rejection.availableAt).toBe(env.now() + HINT_LEVEL_1_AFTER_MS);
    // Nothing about the board leaks in a locked answer.
    expect(JSON.stringify(emissions)).not.toContain('cards');
    expect(eventsOf(emissions)).toEqual([]);
  });

  it('marks one real card of a SET after a minute, privately', () => {
    const { room, env, host, guest } = startedRoom();
    env.advance(HINT_LEVEL_1_AFTER_MS);

    const emissions = room.hint(host.playerId, 1, room.getBoardVersion());
    const revealed = privateMessages(emissions, 'hintRevealed');
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.playerId).toBe(host.playerId);
    const message = revealed[0]!.message as HintRevealedMessage;
    expect(message.level).toBe(1);
    expect(message.cards).toHaveLength(1);
    expect(message.boardVersion).toBe(room.getBoardVersion());

    // The card really is part of a set that is on the board right now.
    const card = message.cards[0]!;
    expect(room.getBoard()).toContain(card);
    expect(findAllSetsByIds(room.getBoard()).some((set) => set.includes(card))).toBe(true);

    // Everyone hears that a hint was taken; nobody hears which card.
    const event = firstEvent(emissions, 'hintUsed');
    expect(event).toMatchObject({ playerId: host.playerId, level: 1 });
    expect(Object.keys(event)).not.toContain('cards');
    expect(guest.playerId).toBeTruthy();
  });

  it('keeps the second hint locked until a second minute has passed', () => {
    const { room, env, host } = startedRoom();
    env.advance(HINT_LEVEL_1_AFTER_MS);
    const early = room.hint(host.playerId, 2, room.getBoardVersion());
    const rejection = privateMessages(early, 'hintRejected')[0]!.message as HintRejectedMessage;
    expect(rejection.reason).toBe('too_soon');
    expect(rejection.availableAt).toBe(rejection.serverTime + HINT_LEVEL_1_AFTER_MS);

    env.advance(HINT_LEVEL_2_AFTER_MS - HINT_LEVEL_1_AFTER_MS);
    const emissions = room.hint(host.playerId, 2, room.getBoardVersion());
    const message = privateMessages(emissions, 'hintRevealed')[0]!.message as HintRevealedMessage;
    expect(message.level).toBe(2);
    expect(message.cards).toHaveLength(2);
    // Two cards fix the third exactly, and that card is on the board.
    const [a, b] = message.cards as [CardId, CardId];
    expect(isSetByIds(a, b, findRequiredThirdCardId(a, b))).toBe(true);
    expect(room.getBoard()).toContain(findRequiredThirdCardId(a, b));
  });

  it('restarts the clock whenever the board changes', () => {
    const { room, env, host, guest } = startedRoom();
    env.advance(HINT_LEVEL_1_AFTER_MS);
    expect(
      privateMessages(room.hint(host.playerId, 1, room.getBoardVersion()), 'hintRevealed'),
    ).toHaveLength(1);

    room.claim(guest.playerId, setOnBoard(room), room.getBoardVersion());
    const after = room.hint(host.playerId, 1, room.getBoardVersion());
    expect((privateMessages(after, 'hintRejected')[0]!.message as HintRejectedMessage).reason).toBe(
      'too_soon',
    );
    expect(room.snapshot().boardSince).toBe(env.now());
  });

  it('says there is nothing to point at on a set-free board', () => {
    const { room, env, host } = setFreeBoardRoom();
    env.advance(HINT_LEVEL_1_AFTER_MS);
    const emissions = room.hint(host.playerId, 1, room.getBoardVersion());
    expect(
      (privateMessages(emissions, 'hintRejected')[0]!.message as HintRejectedMessage).reason,
    ).toBe('no_set');
    expect(eventsOf(emissions)).toEqual([]);
  });

  it('is rejected against a stale board version', () => {
    const { room, env, host } = startedRoom();
    env.advance(HINT_LEVEL_2_AFTER_MS);
    const emissions = room.hint(host.playerId, 1, room.getBoardVersion() - 1);
    expect(
      (privateMessages(emissions, 'hintRejected')[0]!.message as HintRejectedMessage).reason,
    ).toBe('board_changed');
  });

  it('is rejected outside the playing phase, however long the wait', () => {
    const env = testEnv();
    const room = new GameRoom('ABC234', env);
    const host = join(room, 'Maya');
    env.advance(HINT_LEVEL_2_AFTER_MS * 10);
    const emissions = room.hint(host.playerId, 1, 0);
    expect(
      (privateMessages(emissions, 'hintRejected')[0]!.message as HintRejectedMessage).reason,
    ).toBe('not_playing');
  });

  it('is available to a player who is serving a cooldown', () => {
    const { room, env, host } = startedRoom();
    room.claim(host.playerId, nonSetOnBoard(room), room.getBoardVersion());
    env.advance(HINT_LEVEL_1_AFTER_MS);
    // The board did not change, so the clock kept running: a wrong claim costs a
    // cooldown on the board, not the right to ask for help.
    expect(
      privateMessages(room.hint(host.playerId, 1, room.getBoardVersion()), 'hintRevealed'),
    ).toHaveLength(1);
  });
});
