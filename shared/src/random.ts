/**
 * Cross-runtime access to WebCrypto.
 *
 * The same code runs in Workers, browsers and Node, and each supplies its own
 * global typings. Reading the capability off `globalThis` through a minimal
 * structural type keeps this module free of runtime-specific `lib` assumptions
 * without resorting to `any`.
 */

interface RandomValuesCrypto {
  getRandomValues: (array: Uint8Array) => Uint8Array;
}

function webCrypto(): RandomValuesCrypto | undefined {
  const candidate = (globalThis as { crypto?: Partial<RandomValuesCrypto> }).crypto;
  return typeof candidate?.getRandomValues === 'function'
    ? (candidate as RandomValuesCrypto)
    : undefined;
}

/** True when cryptographic randomness is available on this runtime. */
export function hasSecureRandom(): boolean {
  return webCrypto() !== undefined;
}

/**
 * `length` cryptographically strong random bytes.
 * Throws when no secure source exists, so callers never silently downgrade.
 */
export function secureRandomBytes(length: number): Uint8Array {
  const source = webCrypto();
  if (!source) throw new Error('No cryptographic random source available');
  return source.getRandomValues(new Uint8Array(length));
}

/** A random float in `[0, 1)` with 32 bits of entropy, or `null` with no secure source. */
export function secureRandomFloat(): number | null {
  const source = webCrypto();
  if (!source) return null;
  const bytes = source.getRandomValues(new Uint8Array(4));
  const value = ((bytes[0]! << 24) | (bytes[1]! << 16) | (bytes[2]! << 8) | bytes[3]!) >>> 0;
  return value / 4_294_967_296;
}

/** Lowercase hex string of `length` random bytes — used for ids and seat tokens. */
export function secureRandomHex(length: number): string {
  let out = '';
  for (const byte of secureRandomBytes(length)) out += byte.toString(16).padStart(2, '0');
  return out;
}
