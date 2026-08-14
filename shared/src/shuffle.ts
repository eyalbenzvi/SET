/**
 * Deck shuffling.
 *
 * Production uses `crypto.getRandomValues` (available in Workers, browsers and
 * Node 18+). Tests inject a seeded generator so any failure can be reproduced
 * exactly; the seeded generator is never used by the server.
 */

import { secureRandomFloat } from './random.js';

/** Returns a float in `[0, 1)`. */
export type RandomSource = () => number;

/**
 * Cryptographically strong random source. Falls back to `Math.random` only if
 * WebCrypto is entirely absent, which is not the case on any supported runtime
 * (Workers, modern browsers, Node 18+).
 */
export const cryptoRandom: RandomSource = () => secureRandomFloat() ?? Math.random();

/**
 * Deterministic 32-bit generator (mulberry32) for tests and reproducing bugs.
 * Not used in production code paths.
 */
export function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fisher–Yates shuffle. Returns a new array; the input is never mutated.
 */
export function shuffled<T>(items: readonly T[], random: RandomSource = cryptoRandom): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}
