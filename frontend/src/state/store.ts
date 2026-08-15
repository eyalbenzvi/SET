/**
 * The client store: all application state in one place, with rendering strictly
 * separated out. Screens read `getState()` and re-render on `subscribe`.
 *
 * The store applies the server's authoritative snapshots verbatim. It computes
 * nothing about the game itself — no scores, no board changes, no validity. The
 * only local state is presentation: which cards this player has tapped, toasts,
 * and the countdown display for a cooldown the server already decided.
 */

import {
  HINT_DELAY_MS,
  MAX_NAME_LENGTH,
  ROOM_CODE_LENGTH,
  normalizeName,
  normalizeRoomCode,
  type CardId,
  type ClaimRejectedMessage,
  type DealRejectedMessage,
  type ErrorCode,
  type GameEvent,
  type HintLevel,
  type HintRejectedMessage,
  type HintRevealedMessage,
  type PublicState,
  type ServerMessage,
} from '@set/shared';
import { isBackendConfigured } from '../config.js';
import { t, type StringKey } from '../i18n/index.js';
import { createRoom, fetchRoomInfo, type ApiError } from '../net/api.js';
import { GameConnection, type ConnectionStatus } from '../net/connection.js';
import {
  clearSeat,
  loadName,
  loadSeat,
  loadSettings,
  saveName,
  saveSeat,
  saveSettings,
  type Settings,
} from './identity.js';
import { pruneSelection, toggleSelection } from './selection.js';

export type Screen = 'home' | 'lobby' | 'game' | 'results' | 'fatal';
export type HomeMode = 'menu' | 'create' | 'join';
export type Tone = 'good' | 'bad' | 'info';

export interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

export interface Feedback {
  text: string;
  tone: Tone;
}

/** Newest activity-feed entry. Persists until the next event replaces it. */
export interface FeedEntry {
  id: number;
  text: string;
  tone: Tone;
}

/** The cards a hint marked, valid only for the board it was asked about. */
export interface HintState {
  level: HintLevel;
  cards: CardId[];
  boardVersion: number;
}

/** The set that was just taken, so everyone can see what they missed. */
export interface LastSet {
  id: number;
  playerName: string;
  cards: CardId[];
  byMe: boolean;
}

/** What the fatal screen offers the player. */
export type RecoveryAction = 'home' | 'retry' | 'reload';

export interface FatalState {
  message: string;
  actions: RecoveryAction[];
}

export interface AppState {
  screen: Screen;
  homeMode: HomeMode;
  name: string;
  codeInput: string;
  formError: string | null;
  busy: 'creating' | 'joining' | null;
  connection: ConnectionStatus;
  connectionAttempt: number;
  room: PublicState | null;
  meId: string | null;
  selection: CardId[];
  toasts: Toast[];
  /** Latest event, rendered inline by the game screen. */
  feed: FeedEntry | null;
  feedback: Feedback | null;
  /** Cooldown deadline translated into this browser's clock. */
  cooldownUntil: number;
  /** The hint this player asked for, if it still applies to the board on screen. */
  hint: HintState | null;
  /** The most recent set anyone took, shown briefly to the whole table. */
  lastSet: LastSet | null;
  fatal: FatalState | null;
  /** Latest text for the polite live region. */
  announcement: string;
  settings: Settings;
  tutorialOpen: boolean;
  shareConfirmed: boolean;
  /** True while silently resuming a seat from a reload, so failures fall back
   *  to the join form instead of a dead-end error screen. */
  autoResuming: boolean;
}

/** One-shot visual effects. Kept out of state so re-renders never replay them. */
export type Effect =
  | { kind: 'accepted'; cards: CardId[]; byMe: boolean }
  | { kind: 'rejected'; cards: CardId[] }
  | { kind: 'blocked' };

const TOAST_TTL_MS = 3_800;
const MAX_TOASTS = 3;
const FEEDBACK_TTL_MS = 6_000;
/**
 * How long the set that was just taken stays on screen. Long enough to look at
 * three cards and see why they matched, short enough that it is gone before the
 * next set is found.
 */
const LAST_SET_TTL_MS = 7_000;

export class Store {
  private state: AppState;
  private readonly listeners = new Set<() => void>();
  private readonly effectListeners = new Set<(effect: Effect) => void>();
  private connection: GameConnection | null = null;
  private toastSeq = 0;
  private clockOffset = 0;
  private feedbackTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSetTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

  constructor() {
    this.state = {
      screen: 'home',
      homeMode: 'menu',
      name: loadName(),
      codeInput: '',
      formError: null,
      busy: null,
      connection: 'idle',
      connectionAttempt: 0,
      room: null,
      meId: null,
      selection: [],
      toasts: [],
      feed: null,
      feedback: null,
      cooldownUntil: 0,
      hint: null,
      lastSet: null,
      fatal: null,
      announcement: '',
      settings: loadSettings(),
      tutorialOpen: false,
      shareConfirmed: false,
      autoResuming: false,
    };
  }

  /* ---------------------------------------------------------------- *
   * Subscriptions
   * ---------------------------------------------------------------- */

  getState(): Readonly<AppState> {
    return this.state;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEffect(listener: (effect: Effect) => void): () => void {
    this.effectListeners.add(listener);
    return () => this.effectListeners.delete(listener);
  }

  private patch(changes: Partial<AppState>): void {
    this.state = { ...this.state, ...changes };
    this.state = { ...this.state, screen: this.deriveScreen() };
    for (const listener of this.listeners) listener();
  }

  private emit(effect: Effect): void {
    for (const listener of this.effectListeners) listener(effect);
  }

  private deriveScreen(): Screen {
    if (this.state.fatal) return 'fatal';
    const room = this.state.room;
    if (!room) return 'home';
    if (room.phase === 'lobby') return 'lobby';
    if (room.phase === 'playing') return 'game';
    return 'results';
  }

  /* ---------------------------------------------------------------- *
   * Derived helpers used by the UI
   * ---------------------------------------------------------------- */

  me(): PublicState['players'][number] | null {
    const { room, meId } = this.state;
    if (!room || !meId) return null;
    return room.players.find((player) => player.id === meId) ?? null;
  }

  isHost(): boolean {
    return this.me()?.isHost === true;
  }

  /** Whole seconds left on this player's cooldown; 0 when free to act. */
  cooldownSeconds(now = Date.now()): number {
    const remaining = this.state.cooldownUntil - now;
    return remaining > 0 ? Math.ceil(remaining / 1_000) : 0;
  }

  /**
   * True while the server has announced a set-less board and the three cards
   * that resolve it have not landed yet.
   *
   * The board is unclaimable for that moment, so the UI stops taking taps on it
   * rather than letting a player spend the pause building a claim that cannot be
   * right.
   */
  noSetPending(): boolean {
    const room = this.state.room;
    return room !== null && room.phase === 'playing' && room.autoDealAt > 0;
  }

  /** True when this player is one of those asking for three more cards. */
  iWantMoreCards(): boolean {
    const { room, meId } = this.state;
    return room !== null && meId !== null && room.dealVotes.includes(meId);
  }

  /** How many players are asking for more cards, and how many are needed. */
  dealProgress(): { votes: number; needed: number } {
    const room = this.state.room;
    if (!room) return { votes: 0, needed: 0 };
    const needed = Math.max(room.players.filter((player) => player.connected).length, 1);
    return { votes: room.dealVotes.length, needed };
  }

  /**
   * Whole seconds until a hint level unlocks; 0 once it is available.
   *
   * The deadline is a server timestamp, so it is translated through the measured
   * clock offset rather than trusting this device's clock to agree.
   */
  hintUnlockSeconds(level: HintLevel, now = Date.now()): number {
    const room = this.state.room;
    if (!room) return 0;
    const availableAt = room.boardSince - this.clockOffset + HINT_DELAY_MS[level];
    const remaining = availableAt - now;
    return remaining > 0 ? Math.ceil(remaining / 1_000) : 0;
  }

  /** The hint cards, but only while they still describe the board on screen. */
  activeHint(): HintState | null {
    const { hint, room } = this.state;
    if (!hint || !room) return null;
    return hint.boardVersion === room.boardVersion ? hint : null;
  }

  /** Players ordered for the score strip: highest score first, then join order. */
  ranked(): PublicState['players'] {
    const room = this.state.room;
    if (!room) return [];
    return room.players
      .map((player, index) => ({ player, index }))
      .sort((a, b) => b.player.score - a.player.score || a.index - b.index)
      .map((entry) => entry.player);
  }

  /* ---------------------------------------------------------------- *
   * Home screen actions
   * ---------------------------------------------------------------- */

  /**
   * Handle the URL the app was opened with.
   *
   * A `#room=CODE` link pre-fills the join form. If this browser also still
   * holds a seat in that room — the case after an accidental reload — the seat is
   * resumed silently, so a reload mid-game puts the player straight back on the
   * board with their score intact rather than making them re-enter their name.
   */
  init(): void {
    if (!isBackendConfigured()) {
      this.patch({ fatal: { message: t('error.backendUnconfigured'), actions: ['reload'] } });
      return;
    }
    const hash = globalThis.location?.hash ?? '';
    const match = /[#&]room=([^&]+)/.exec(hash);
    const code = match ? normalizeRoomCode(decodeURIComponent(match[1]!)) : null;
    if (!code) return;
    this.patch({ codeInput: code, homeMode: 'join' });

    const seat = loadSeat(code);
    const name = normalizeName(this.state.name);
    if (seat && name !== null) {
      this.patch({ busy: 'joining', autoResuming: true });
      this.openConnection(code, name);
    }
  }

  setHomeMode(mode: HomeMode): void {
    this.patch({ homeMode: mode, formError: null });
  }

  /**
   * Record the typed name **without** notifying listeners.
   *
   * The name field is owned by the DOM while the player types in it. Publishing
   * a state change per keystroke would re-render the screen, destroy the focused
   * input and eject the player mid-word — so this writes through silently and the
   * screen reads the value back only when it is not focused.
   */
  setName(name: string): void {
    this.state = { ...this.state, name, formError: null };
  }

  /** Same contract as `setName`, plus the room-code normalisation rules. */
  normalizeCodeInput(raw: string): string {
    const codeInput = raw.toUpperCase().replace(/\s+/g, '').slice(0, ROOM_CODE_LENGTH);
    this.state = { ...this.state, codeInput, formError: null };
    return codeInput;
  }

  /** Set the room code from outside the input (a join link), with a re-render. */
  setCodeInput(code: string): void {
    this.patch({ codeInput: code.toUpperCase().slice(0, ROOM_CODE_LENGTH), formError: null });
  }

  setTutorialOpen(open: boolean): void {
    this.patch({ tutorialOpen: open });
  }

  setColorAssist(enabled: boolean): void {
    const settings: Settings = { ...this.state.settings, colorAssist: enabled };
    saveSettings(settings);
    this.patch({ settings });
  }

  private validName(): string | null {
    const raw = this.state.name;
    if (raw.trim().length === 0) {
      this.patch({ formError: t('home.nameRequired') });
      return null;
    }
    const name = normalizeName(raw);
    if (name === null) {
      this.patch({ formError: t('home.nameTooLong', { max: MAX_NAME_LENGTH }) });
      return null;
    }
    return name;
  }

  /** Create a room and join it as host. */
  async submitCreate(): Promise<void> {
    const name = this.validName();
    if (name === null || this.state.busy) return;
    saveName(name);
    this.patch({ busy: 'creating', formError: null });
    const result = await createRoom();
    if (!result.ok) {
      this.patch({ busy: null, formError: describeApiError(result.error) });
      return;
    }
    this.openConnection(result.value, name);
  }

  /** Join an existing room by code. */
  async submitJoin(): Promise<void> {
    if (this.state.busy) return;
    const code = normalizeRoomCode(this.state.codeInput);
    if (code === null) {
      this.patch({
        formError:
          this.state.codeInput.trim().length === 0
            ? t('home.codeRequired')
            : t('home.codeInvalid', { length: ROOM_CODE_LENGTH }),
      });
      return;
    }
    const name = this.validName();
    if (name === null) return;
    saveName(name);
    this.patch({ busy: 'joining', formError: null });

    // Check the room first so a wrong code is explained before a socket opens.
    const info = await fetchRoomInfo(code);
    if (!info.ok) {
      this.patch({ busy: null, formError: describeApiError(info.error) });
      return;
    }
    const seat = loadSeat(code);
    if (!info.value.canJoin && !seat) {
      this.patch({
        busy: null,
        formError:
          info.value.phase === 'lobby' ? t('error.roomFull') : t('error.gameAlreadyStarted'),
      });
      return;
    }
    this.openConnection(code, name);
  }

  private openConnection(code: string, name: string): void {
    this.connection?.leave();
    const connection = new GameConnection(code, name, {
      onStatus: (status, attempt) => this.onStatus(status, attempt),
      onMessage: (message) => this.onMessage(message),
      onFatal: (reason) => this.onFatalConnection(reason),
    });
    // Resume this browser's seat in this room, if it still holds one.
    const seat = loadSeat(code);
    if (seat) connection.setCredentials({ playerId: seat.playerId, token: seat.token });
    this.connection = connection;
    connection.connect();
  }

  /* ---------------------------------------------------------------- *
   * Game actions
   * ---------------------------------------------------------------- */

  toggleCard(cardId: CardId): void {
    const room = this.state.room;
    if (room?.phase !== 'playing') return;
    if (this.cooldownSeconds() > 0) return;
    if (this.noSetPending()) return;
    const change = toggleSelection(this.state.selection, cardId, room.board);
    if (change.blocked) {
      this.emit({ kind: 'blocked' });
      this.setFeedback(t('game.fourthBlocked'), 'info');
      return;
    }
    this.patch({ selection: change.selection });
  }

  clearSelection(): void {
    this.patch({ selection: [] });
  }

  claim(): void {
    const room = this.state.room;
    if (!room || this.state.selection.length !== 3) return;
    if (this.cooldownSeconds() > 0 || this.noSetPending()) return;
    this.connection?.send({
      t: 'claim',
      cards: [...this.state.selection],
      boardVersion: room.boardVersion,
    });
  }

  /**
   * Ask for three more cards, or take the request back — the same button both
   * ways, so the player who asked can always change their mind.
   *
   * Deliberately allowed during a cooldown: this is a request to the table, not a
   * move on the board, and the cards only appear once everyone agrees.
   */
  toggleMoreCards(): void {
    const room = this.state.room;
    if (room?.phase !== 'playing') return;
    // Cards are already on their way; asking for more would be about a board that
    // is about to be replaced.
    if (this.noSetPending()) return;
    this.connection?.send({
      t: 'deal',
      want: !this.iWantMoreCards(),
      boardVersion: room.boardVersion,
    });
  }

  /** Ask the server for a hint. It answers only this player. */
  requestHint(level: HintLevel): void {
    const room = this.state.room;
    if (room?.phase !== 'playing') return;
    this.connection?.send({ t: 'hint', level, boardVersion: room.boardVersion });
  }

  startGame(): void {
    this.connection?.send({ t: 'start' });
  }

  requestRematch(): void {
    this.connection?.send({ t: 'rematch' });
  }

  /** Leave the room and return to the home screen. */
  leaveRoom(): void {
    const code = this.state.room?.code;
    if (code) clearSeat(code);
    this.connection?.leave();
    this.connection = null;
    this.clearTimers();
    this.patch({
      room: null,
      meId: null,
      selection: [],
      toasts: [],
      feed: null,
      feedback: null,
      cooldownUntil: 0,
      hint: null,
      lastSet: null,
      fatal: null,
      busy: null,
      homeMode: 'menu',
      connection: 'idle',
      announcement: '',
      autoResuming: false,
    });
    this.clearHash();
  }

  /** Retry after the connection was given up on. */
  retryConnection(): void {
    this.patch({ fatal: null });
    if (this.connection) this.connection.retry();
    else this.patch({ room: null, busy: null });
  }

  goHome(): void {
    this.leaveRoom();
  }

  confirmShare(): void {
    this.patch({ shareConfirmed: true });
    setTimeout(() => this.patch({ shareConfirmed: false }), 2_000);
  }

  /* ---------------------------------------------------------------- *
   * Server message handling
   * ---------------------------------------------------------------- */

  private onStatus(status: ConnectionStatus, attempt: number): void {
    this.patch({ connection: status, connectionAttempt: attempt });
    if (status === 'reconnecting') {
      this.patch({ announcement: t('status.reconnecting', { attempt: Math.max(attempt, 1) }) });
    }
  }

  private onFatalConnection(reason: 'server' | 'unreachable'): void {
    if (reason === 'unreachable' && this.state.autoResuming) {
      this.patch({ autoResuming: false, busy: null, formError: t('error.network') });
      return;
    }
    if (reason === 'unreachable') {
      this.patch({
        busy: null,
        fatal: { message: t('error.network'), actions: ['retry', 'home'] },
      });
    }
    // A fatal server error already produced a message via `onMessage`.
  }

  private onMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome': {
        this.patch({ autoResuming: false });
        this.clockOffset = message.state.serverTime - Date.now();
        saveSeat(message.state.code, message.you.playerId, message.you.token);
        this.patch({ meId: message.you.playerId, busy: null, formError: null });
        this.applyState(message.state);
        this.setHash(message.state.code);
        return;
      }
      case 'state':
        this.applyState(message.state);
        return;
      case 'event':
        this.applyState(message.state);
        this.handleEvent(message.event);
        return;
      case 'claimRejected':
        this.handleClaimRejected(message);
        return;
      case 'hintRevealed':
        this.handleHintRevealed(message);
        return;
      case 'hintRejected':
        this.handleHintRejected(message);
        return;
      case 'dealRejected':
        this.handleDealRejected(message);
        return;
      case 'error':
        this.handleServerError(message.code, message.message, message.fatal);
        return;
      case 'pong':
        this.clockOffset = message.serverTime - Date.now();
        return;
      default:
        return;
    }
  }

  /** Apply an authoritative snapshot, dropping any now-invalid local selection. */
  private applyState(state: PublicState): void {
    const previous = this.state.room;
    this.clockOffset = state.serverTime - Date.now();
    const boardChanged = previous?.boardVersion !== state.boardVersion;
    const selection = boardChanged ? [] : pruneSelection(this.state.selection, state.board);
    const me = state.players.find((player) => player.id === this.state.meId);
    const cooldownUntil = me?.cooldownUntil ? me.cooldownUntil - this.clockOffset : 0;
    // A hint describes one board. Once that board is gone the marks would point
    // at cards that no longer belong to a set, so they go with it.
    const hint = boardChanged ? null : this.state.hint;
    this.patch({ room: state, selection, cooldownUntil, hint, busy: null });
  }

  private handleEvent(event: GameEvent): void {
    const mine = 'playerId' in event && event.playerId === this.state.meId;
    switch (event.k) {
      case 'setFound': {
        const text = mine ? t('feed.setFoundYou') : t('feed.setFound', { name: event.playerName });
        this.pushToast(text, 'good');
        this.showLastSet(event.playerName, event.cards, mine);
        this.emit({ kind: 'accepted', cards: event.cards, byMe: mine });
        return;
      }
      case 'invalidClaim':
        if (!mine) this.pushToast(t('feed.invalidClaim', { name: event.playerName }), 'bad');
        return;
      case 'cardsAdded':
        this.pushToast(
          event.reason === 'agreed' ? t('feed.cardsAddedAgreed') : t('feed.cardsAdded'),
          'info',
        );
        return;
      case 'noSetOnBoard':
        // Nobody called this and nobody can act on it: it is the table being told
        // to stop looking, so it clears the selection everyone was building.
        this.patch({ selection: [], hint: null });
        this.pushToast(event.dealsAt > 0 ? t('feed.noSetOnBoard') : t('feed.noSetFinal'), 'info');
        return;
      case 'dealVote': {
        if (mine) {
          this.setFeedback(
            event.want
              ? t('feed.dealAskedYou', { votes: event.votes, needed: event.needed })
              : t('feed.dealWithdrewYou'),
            'info',
          );
          return;
        }
        this.pushToast(
          event.want
            ? t('feed.dealAsked', {
                name: event.playerName,
                votes: event.votes,
                needed: event.needed,
              })
            : t('feed.dealWithdrew', { name: event.playerName }),
          'info',
        );
        return;
      }
      case 'dealLapsed':
        this.pushToast(t('feed.dealLapsed'), 'info');
        return;
      case 'hintUsed':
        // Everyone hears that a hint was taken, but never which cards it named.
        if (!mine) this.pushToast(t('feed.hintUsed', { name: event.playerName }), 'info');
        return;
      case 'playerJoined':
        this.pushToast(t('feed.playerJoined', { name: event.playerName }), 'info');
        return;
      case 'playerLeft':
        this.pushToast(t('feed.playerLeft', { name: event.playerName }), 'info');
        return;
      case 'playerDisconnected':
        this.pushToast(t('feed.playerDisconnected', { name: event.playerName }), 'bad');
        return;
      case 'playerReconnected':
        this.pushToast(t('feed.playerReconnected', { name: event.playerName }), 'good');
        return;
      case 'hostChanged':
        this.pushToast(t('feed.hostChanged', { name: event.playerName }), 'info');
        return;
      case 'gameStarted':
        // A phase change wipes stale messages so they cannot pile up on the next
        // screen and sit on top of its buttons.
        this.clearMessages();
        this.patch({ selection: [], feedback: null, hint: null, lastSet: null });
        this.pushToast(t('feed.gameStarted'), 'good');
        return;
      case 'rematchWanted':
        if (!mine) this.pushToast(t('feed.rematchWanted', { name: event.playerName }), 'info');
        return;
      case 'gameOver': {
        const iWon = event.winnerIds.includes(this.state.meId ?? '');
        this.clearMessages();
        this.patch({
          announcement:
            event.winnerIds.length > 1
              ? t('results.tie', { names: event.winnerNames.join(', ') })
              : iWon
                ? t('results.winnerYou')
                : t('results.winner', { name: event.winnerNames[0] ?? '' }),
          selection: [],
          hint: null,
          lastSet: null,
        });
        return;
      }
      default:
        return;
    }
  }

  private handleClaimRejected(message: ClaimRejectedMessage): void {
    const cooldownUntil =
      message.cooldownUntil > 0 ? message.cooldownUntil - (message.serverTime - Date.now()) : 0;
    switch (message.reason) {
      case 'not_a_set': {
        const text = message.mismatch
          ? t('reject.notASet', {
              repeated: t(
                `value.${message.mismatch.attribute}.${message.mismatch.repeatedValue}` as StringKey,
              ),
              odd: t(
                `value.${message.mismatch.attribute}.${message.mismatch.oddValue}` as StringKey,
              ),
              attribute: t(`attribute.${message.mismatch.attribute}` as StringKey),
            })
          : t('reject.notASetGeneric');
        this.emit({ kind: 'rejected', cards: [...this.state.selection] });
        this.setFeedback(text, 'bad');
        this.patch({ cooldownUntil, announcement: text });
        return;
      }
      case 'board_changed':
        this.setFeedback(t('reject.boardChanged'), 'info');
        this.patch({ selection: [], cooldownUntil });
        return;
      case 'cooldown':
        this.setFeedback(t('reject.cooldown'), 'info');
        this.patch({ cooldownUntil });
        return;
      case 'invalid_cards':
        this.setFeedback(t('reject.invalidCards'), 'info');
        this.patch({ selection: [], cooldownUntil });
        return;
      case 'not_playing':
        this.setFeedback(t('reject.notPlaying'), 'info');
        this.patch({ cooldownUntil });
        return;
      case 'no_set_on_board':
        // Not a mistake, so no cooldown and no red: the claim was made in the
        // moment between the announcement and the cards arriving.
        this.setFeedback(t('reject.noSetOnBoard'), 'info');
        this.patch({ selection: [], cooldownUntil });
        return;
      default:
        return;
    }
  }

  private handleHintRevealed(message: HintRevealedMessage): void {
    this.patch({
      hint: { level: message.level, cards: message.cards, boardVersion: message.boardVersion },
    });
    const text = message.level === 1 ? t('hint.revealedOne') : t('hint.revealedTwo');
    this.setFeedback(text, 'info');
    this.patch({ announcement: text });
  }

  private handleHintRejected(message: HintRejectedMessage): void {
    const text =
      message.reason === 'too_soon'
        ? t('hint.tooSoon', {
            seconds: Math.max(Math.ceil((message.availableAt - message.serverTime) / 1_000), 1),
          })
        : message.reason === 'no_set'
          ? t('hint.noSet')
          : message.reason === 'board_changed'
            ? t('reject.boardChanged')
            : t('reject.notPlaying');
    this.setFeedback(text, 'info');
    this.patch({ announcement: text });
  }

  private handleDealRejected(message: DealRejectedMessage): void {
    const text =
      message.reason === 'deck_empty'
        ? t('deal.deckEmpty')
        : message.reason === 'board_full'
          ? t('deal.boardFull')
          : message.reason === 'board_changed'
            ? t('reject.boardChanged')
            : t('reject.notPlaying');
    this.setFeedback(text, 'info');
    this.patch({ announcement: text });
  }

  /**
   * Put the set that was just taken on screen for a few seconds.
   *
   * The cards are already sliding off the board by the time this runs, which is
   * exactly the problem it solves: without it, a player who was looking elsewhere
   * never finds out what the set was.
   */
  private showLastSet(playerName: string, cards: CardId[], byMe: boolean): void {
    if (this.lastSetTimer !== null) clearTimeout(this.lastSetTimer);
    this.patch({
      lastSet: { id: ++this.toastSeq, playerName, cards: [...cards], byMe },
    });
    this.lastSetTimer = setTimeout(() => this.patch({ lastSet: null }), LAST_SET_TTL_MS);
  }

  private handleServerError(code: ErrorCode, message: string, fatal: boolean): void {
    if (!fatal) {
      this.setFeedback(message, 'bad');
      this.pushToast(message, 'bad');
      return;
    }
    // A fatal error means this seat/room cannot be used as-is.
    const roomCode = this.state.room?.code ?? normalizeRoomCode(this.state.codeInput);
    if (code === 'not_authorized' && roomCode) clearSeat(roomCode);

    // A silent resume that fails is not an error the player asked for: drop them
    // on the join form with an explanation instead of a dead-end error screen.
    if (this.state.autoResuming) {
      if (roomCode) clearSeat(roomCode);
      this.connection = null;
      this.patch({ autoResuming: false, busy: null, formError: message, room: null });
      return;
    }
    const actions: RecoveryAction[] =
      code === 'protocol_version_mismatch' ? ['reload'] : ['home', 'retry'];
    this.clearTimers();
    this.patch({ busy: null, fatal: { message, actions }, room: null, selection: [] });
  }

  /* ---------------------------------------------------------------- *
   * Toasts, feedback and the live region
   * ---------------------------------------------------------------- */

  /**
   * Record an event. It shows as a floating toast outside the game (lobby,
   * results) and as the header feed line during play, where a floating stack
   * would cover cards.
   */
  private pushToast(text: string, tone: Tone): void {
    const id = ++this.toastSeq;
    const toasts = [...this.state.toasts, { id, text, tone }].slice(-MAX_TOASTS);
    this.patch({ toasts, feed: { id, text, tone }, announcement: text });
    const timer = setTimeout(() => this.dismissToast(id), TOAST_TTL_MS);
    this.toastTimers.set(id, timer);
  }

  dismissToast(id: number): void {
    const timer = this.toastTimers.get(id);
    if (timer) clearTimeout(timer);
    this.toastTimers.delete(id);
    this.patch({ toasts: this.state.toasts.filter((toast) => toast.id !== id) });
  }

  private setFeedback(text: string, tone: Tone): void {
    if (this.feedbackTimer !== null) clearTimeout(this.feedbackTimer);
    this.patch({ feedback: { text, tone } });
    this.feedbackTimer = setTimeout(() => this.patch({ feedback: null }), FEEDBACK_TTL_MS);
  }

  /** Drop every pending toast and the inline feedback line. */
  private clearMessages(): void {
    this.clearTimers();
    this.patch({ toasts: [], feed: null, feedback: null });
  }

  private clearTimers(): void {
    if (this.feedbackTimer !== null) clearTimeout(this.feedbackTimer);
    this.feedbackTimer = null;
    if (this.lastSetTimer !== null) clearTimeout(this.lastSetTimer);
    this.lastSetTimer = null;
    for (const timer of this.toastTimers.values()) clearTimeout(timer);
    this.toastTimers.clear();
  }

  /** Keep the room in the URL so a reload rejoins the same room. */
  private setHash(code: string): void {
    try {
      globalThis.history?.replaceState(null, '', `#room=${encodeURIComponent(code)}`);
    } catch {
      /* history unavailable */
    }
  }

  private clearHash(): void {
    try {
      globalThis.history?.replaceState(null, '', globalThis.location.pathname);
    } catch {
      /* history unavailable */
    }
  }
}

/** Map an API failure onto a short, non-technical message. */
export function describeApiError(error: ApiError): string {
  switch (error.kind) {
    case 'unconfigured':
      return t('error.backendUnconfigured');
    case 'room_not_found':
      return t('error.roomNotFound');
    case 'invalid_code':
      return t('home.codeInvalid', { length: ROOM_CODE_LENGTH });
    case 'origin_not_allowed':
      // A deployment mistake, not a flaky network: say which knob to turn.
      return t('error.originNotAllowed');
    case 'network':
      return t('error.network');
    default:
      return t('error.generic');
  }
}
