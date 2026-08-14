/**
 * Cloudflare Worker entrypoint.
 *
 * Responsibilities kept here (and nowhere else):
 *  - Origin allow-listing / CORS for the static GitHub Pages frontend.
 *  - Minting collision-resistant room codes.
 *  - Routing a request to the one Durable Object that owns that room.
 *
 * The Worker holds no game state whatsoever.
 */

import {
  PROTOCOL_VERSION,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  normalizeRoomCode,
} from '@set/shared';
import { GameRoomDO } from './room-do.js';

export { GameRoomDO };

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  /**
   * Comma-separated list of browser origins allowed to talk to this Worker,
   * e.g. `https://eyalbenzvi.github.io`. Localhost is always allowed so local
   * development needs no configuration.
   */
  ALLOWED_ORIGINS?: string;
}

/** How many code candidates to try before giving up (collisions are vanishingly rare). */
const MAX_CODE_ATTEMPTS = 8;

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' } as const;

/** Local development origins, allowed unconditionally. */
function isLocalOrigin(origin: string): boolean {
  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'http:' && protocol !== 'https:') return false;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim().replace(/\/$/, ''))
    .filter((value) => value.length > 0 && !value.startsWith('#'));
}

/**
 * Decide whether a browser origin may use this backend.
 *
 * Requests with no `Origin` header (curl, uptime checks) are allowed — there is
 * nothing to protect, since the API carries no credentials and no cookies.
 */
function resolveOrigin(request: Request, env: Env): { allowed: boolean; origin: string | null } {
  const origin = request.headers.get('Origin');
  if (origin === null) return { allowed: true, origin: null };
  const normalized = origin.replace(/\/$/, '');
  if (isLocalOrigin(normalized)) return { allowed: true, origin: normalized };
  return { allowed: allowedOrigins(env).includes(normalized), origin: normalized };
}

function corsHeaders(origin: string | null): Record<string, string> {
  if (origin === null) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  origin: string | null,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(origin), ...extra },
  });
}

/** Room code from the allow-listed alphabet, using cryptographic randomness. */
function generateRoomCode(): string {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const byte of bytes) {
    // 256 % 32 === 0, so the modulo introduces no bias for this alphabet size.
    code += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
  }
  return code;
}

function roomStub(env: Env, code: string): DurableObjectStub {
  return env.GAME_ROOM.get(env.GAME_ROOM.idFromName(`room:${code}`));
}

/** Create a room, retrying on the (astronomically unlikely) code collision. */
async function createRoom(env: Env): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS; attempt++) {
    const code = generateRoomCode();
    const response = await roomStub(env, code).fetch(
      `https://room.internal/create?code=${encodeURIComponent(code)}`,
      { method: 'POST' },
    );
    if (response.ok) return code;
    if (response.status !== 409) return null;
  }
  return null;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { allowed, origin } = resolveOrigin(request, env);
    const url = new URL(request.url);

    if (!allowed) {
      // Explicit and self-documenting: the deployer needs to add their origin.
      return jsonResponse(
        {
          error: 'origin_not_allowed',
          message:
            'This backend is not configured for your origin. Add it to the ALLOWED_ORIGINS variable of the Worker.',
        },
        403,
        null,
      );
    }

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // GET /health — liveness plus the protocol version the client must speak.
    if (url.pathname === '/health' && request.method === 'GET') {
      return jsonResponse({ ok: true, protocol: PROTOCOL_VERSION }, 200, origin, {
        'cache-control': 'no-store',
      });
    }

    // POST /api/rooms — mint a new room.
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      const code = await createRoom(env);
      if (code === null) {
        return jsonResponse({ error: 'could_not_create_room' }, 503, origin);
      }
      return jsonResponse({ code, protocol: PROTOCOL_VERSION }, 201, origin, {
        'cache-control': 'no-store',
      });
    }

    // GET /api/rooms/:code — pre-join check, so the UI can explain a bad code
    // before it opens a socket.
    const infoMatch = /^\/api\/rooms\/([^/]+)$/.exec(url.pathname);
    if (infoMatch && request.method === 'GET') {
      const code = normalizeRoomCode(decodeURIComponent(infoMatch[1]!));
      if (code === null) return jsonResponse({ exists: false, error: 'invalid_code' }, 400, origin);
      const response = await roomStub(env, code).fetch('https://room.internal/info');
      const body = await response.text();
      return new Response(body, {
        status: response.status,
        headers: { ...JSON_HEADERS, ...corsHeaders(origin), 'cache-control': 'no-store' },
      });
    }

    // GET /api/rooms/:code/ws — the real-time game socket.
    const wsMatch = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (wsMatch) {
      const code = normalizeRoomCode(decodeURIComponent(wsMatch[1]!));
      if (code === null) return jsonResponse({ error: 'invalid_code' }, 400, origin);
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return jsonResponse({ error: 'expected_websocket' }, 426, origin);
      }
      return roomStub(env, code).fetch(
        `https://room.internal/ws?code=${encodeURIComponent(code)}`,
        request,
      );
    }

    return jsonResponse({ error: 'not_found' }, 404, origin);
  },
} satisfies ExportedHandler<Env>;
