/**
 * Runtime configuration.
 *
 * The backend URL is a build-time value (`VITE_API_BASE`) so the static bundle
 * on GitHub Pages never has to guess where the Worker lives. A localStorage
 * override exists purely for debugging a deployed build against a local Worker.
 */

const OVERRIDE_KEY = 'set.apiBase';
const DEV_FALLBACK = 'http://127.0.0.1:8787';

function readOverride(): string | null {
  try {
    return globalThis.localStorage?.getItem(OVERRIDE_KEY) ?? null;
  } catch {
    // Private browsing modes can throw on storage access.
    return null;
  }
}

function normalize(base: string): string {
  return base.trim().replace(/\/+$/, '');
}

/**
 * Base URL of the Worker, without a trailing slash. Empty when the production
 * build was made without `VITE_API_BASE`, which the UI reports as a
 * configuration problem instead of failing mysteriously at connect time.
 */
export function apiBase(): string {
  const override = readOverride();
  if (override) return normalize(override);
  const configured: unknown = import.meta.env.VITE_API_BASE;
  if (typeof configured === 'string' && configured.trim().length > 0) return normalize(configured);
  return import.meta.env.DEV ? DEV_FALLBACK : '';
}

/** `ws(s)://…` form of the API base. */
export function wsBase(): string {
  return apiBase().replace(/^http/, 'ws');
}

export function isBackendConfigured(): boolean {
  return apiBase().length > 0;
}

/** Absolute URL of this app, used to build shareable join links. */
export function appBaseUrl(): string {
  const { origin, pathname } = globalThis.location;
  const base = import.meta.env.BASE_URL || '/';
  // BASE_URL is the configured Pages subpath; prefer it so links work from
  // `/set/` as well as from the domain root.
  if (base !== '/' && base !== './') return `${origin}${base.endsWith('/') ? base : `${base}/`}`;
  return `${origin}${pathname.replace(/[^/]*$/, '')}`;
}

/** Shareable link that opens the app with the join form pre-filled. */
export function joinUrl(code: string): string {
  return `${appBaseUrl()}#room=${encodeURIComponent(code)}`;
}
