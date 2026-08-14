/**
 * Per-browser persistence: display name, seat credentials and display settings.
 *
 * Seat credentials are what let an accidental reload drop the player back into
 * their own seat with their score intact. They are stored per room code and
 * pruned so the key cannot grow without bound. Nothing here is sent anywhere
 * except back to the room that issued it.
 */

const NAME_KEY = 'set.playerName';
const SEATS_KEY = 'set.seats';
const SETTINGS_KEY = 'set.settings';
/** Seat records older than this are dropped; rooms do not outlive them. */
const SEAT_TTL_MS = 6 * 60 * 60 * 1_000;
const MAX_SEATS = 12;

export interface Seat {
  playerId: string;
  token: string;
  savedAt: number;
}

export interface Settings {
  /** Adds a letter marker to each card so colour is not the only cue. */
  colorAssist: boolean;
}

const DEFAULT_SETTINGS: Settings = { colorAssist: false };

function read(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // Storage can be unavailable (private mode, quota). The game still works;
    // the player simply cannot resume a seat after a reload.
  }
}

export function loadName(): string {
  return read(NAME_KEY) ?? '';
}

export function saveName(name: string): void {
  write(NAME_KEY, name);
}

function loadSeats(): Record<string, Seat> {
  const raw = read(SEATS_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: Record<string, Seat> = {};
    const now = Date.now();
    for (const [code, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const seat = value as Partial<Seat>;
      if (typeof seat.playerId !== 'string' || typeof seat.token !== 'string') continue;
      const savedAt = typeof seat.savedAt === 'number' ? seat.savedAt : 0;
      if (now - savedAt > SEAT_TTL_MS) continue;
      out[code] = { playerId: seat.playerId, token: seat.token, savedAt };
    }
    return out;
  } catch {
    return {};
  }
}

export function loadSeat(code: string): Seat | null {
  return loadSeats()[code] ?? null;
}

export function saveSeat(code: string, playerId: string, token: string): void {
  const seats = loadSeats();
  seats[code] = { playerId, token, savedAt: Date.now() };
  // Keep only the most recent rooms.
  const trimmed = Object.entries(seats)
    .sort((a, b) => b[1].savedAt - a[1].savedAt)
    .slice(0, MAX_SEATS);
  write(SEATS_KEY, JSON.stringify(Object.fromEntries(trimmed)));
}

export function clearSeat(code: string): void {
  const seats = loadSeats();
  delete seats[code];
  write(SEATS_KEY, JSON.stringify(seats));
}

export function loadSettings(): Settings {
  const raw = read(SETTINGS_KEY);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return { colorAssist: parsed.colorAssist === true };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  write(SETTINGS_KEY, JSON.stringify(settings));
}
