/**
 * The two HTTP calls the client makes. Everything else happens over the socket.
 */

import { apiBase } from '../config.js';

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export type ApiError =
  | { kind: 'unconfigured' }
  | { kind: 'network' }
  | { kind: 'room_not_found' }
  | { kind: 'invalid_code' }
  | { kind: 'origin_not_allowed' }
  | { kind: 'server'; status: number };

export interface RoomInfo {
  exists: boolean;
  phase: 'lobby' | 'playing' | 'finished';
  players: number;
  maxPlayers: number;
  canJoin: boolean;
}

const REQUEST_TIMEOUT_MS = 10_000;

async function request(path: string, init?: RequestInit): Promise<Response | ApiError> {
  const base = apiBase();
  if (!base) return { kind: 'unconfigured' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${base}${path}`, { ...init, signal: controller.signal });
  } catch {
    // Network failure, DNS failure, CORS rejection or timeout all land here; the
    // user-facing message is the same and never exposes the internal reason.
    return { kind: 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function isApiError(value: Response | ApiError): value is ApiError {
  return !(value instanceof Response);
}

/** Create a room and return its code. */
export async function createRoom(): Promise<ApiResult<string>> {
  const response = await request('/api/rooms', { method: 'POST' });
  if (isApiError(response)) return { ok: false, error: response };
  if (response.status === 403) return { ok: false, error: { kind: 'origin_not_allowed' } };
  if (!response.ok) return { ok: false, error: { kind: 'server', status: response.status } };
  const body = (await response.json()) as { code?: unknown };
  if (typeof body.code !== 'string') return { ok: false, error: { kind: 'server', status: 200 } };
  return { ok: true, value: body.code };
}

/**
 * Check a room before opening a socket, so a mistyped code produces a clear
 * message instead of an opaque socket failure.
 */
export async function fetchRoomInfo(code: string): Promise<ApiResult<RoomInfo>> {
  const response = await request(`/api/rooms/${encodeURIComponent(code)}`);
  if (isApiError(response)) return { ok: false, error: response };
  if (response.status === 404) return { ok: false, error: { kind: 'room_not_found' } };
  if (response.status === 400) return { ok: false, error: { kind: 'invalid_code' } };
  if (response.status === 403) return { ok: false, error: { kind: 'origin_not_allowed' } };
  if (!response.ok) return { ok: false, error: { kind: 'server', status: response.status } };
  return { ok: true, value: (await response.json()) as RoomInfo };
}
