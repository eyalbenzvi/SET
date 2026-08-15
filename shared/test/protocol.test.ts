import { describe, expect, it } from 'vitest';
import {
  MAX_MESSAGE_BYTES,
  MAX_NAME_LENGTH,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  normalizeName,
  normalizeRoomCode,
  parseClientMessage,
} from '../src/protocol.js';

const encode = (value: unknown): string => JSON.stringify(value);

function expectRejected(raw: unknown): string {
  const result = parseClientMessage(raw);
  expect(result.ok).toBe(false);
  return result.ok ? '' : result.error;
}

describe('normalizeName', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeName('  Maya   Cohen ')).toBe('Maya Cohen');
    expect(normalizeName('\tDavid\n')).toBe('David');
  });

  it('rejects empty, whitespace-only and non-string input', () => {
    for (const bad of ['', '   ', '\n\t', null, undefined, 42, {}, [], true]) {
      expect(normalizeName(bad)).toBeNull();
    }
  });

  it('strips control characters and bidi overrides', () => {
    expect(normalizeName('Ma\u0007ya')).toBe('Ma ya');
    expect(normalizeName('Ma\u202eya')).toBe('Ma ya');
    expect(normalizeName('\u200b\u200bMaya')).toBe('Maya');
    expect(normalizeName('\u2066Maya\u2069')).toBe('Maya');
    expect(normalizeName('\u0000\u001f')).toBeNull();
  });

  it('enforces the 20 visible character limit, counting code points', () => {
    expect(normalizeName('A'.repeat(MAX_NAME_LENGTH))).toBe('A'.repeat(MAX_NAME_LENGTH));
    expect(normalizeName('A'.repeat(MAX_NAME_LENGTH + 1))).toBeNull();
    // Emoji are single code points, not UTF-16 units.
    expect(normalizeName('🎲'.repeat(MAX_NAME_LENGTH))).toBe('🎲'.repeat(MAX_NAME_LENGTH));
    expect(normalizeName('🎲'.repeat(MAX_NAME_LENGTH + 1))).toBeNull();
  });

  it('keeps markup as literal text (names are rendered as text nodes, never HTML)', () => {
    expect(normalizeName('<b>bold</b>')).toBe('<b>bold</b>');
    expect(normalizeName('<script>x()')).toBe('<script>x()');
    expect(normalizeName('Bobby "; DROP')).toBe('Bobby "; DROP');
    // ...and anything long enough to be a real payload is refused on length alone.
    expect(normalizeName('<img src=x onerror=alert(1)>')).toBeNull();
  });

  it('accepts non-Latin scripts, ready for a Hebrew UI', () => {
    expect(normalizeName('  מיה  ')).toBe('מיה');
  });
});

describe('normalizeRoomCode', () => {
  it('uppercases and accepts a well-formed code', () => {
    expect(normalizeRoomCode('abc234')).toBe('ABC234');
    expect(normalizeRoomCode(' ABC234 ')).toBe('ABC234');
  });

  it('rejects wrong lengths and confusable characters', () => {
    expect(normalizeRoomCode('ABC23')).toBeNull();
    expect(normalizeRoomCode('ABC2345')).toBeNull();
    expect(normalizeRoomCode('ABC23O')).toBeNull();
    expect(normalizeRoomCode('ABC23I')).toBeNull();
    expect(normalizeRoomCode('ABC230')).toBeNull();
    expect(normalizeRoomCode('ABC231')).toBeNull();
    expect(normalizeRoomCode('AB-234')).toBeNull();
    expect(normalizeRoomCode(123456)).toBeNull();
    expect(normalizeRoomCode(null)).toBeNull();
  });

  it('has an alphabet free of visually confusable characters', () => {
    expect(ROOM_CODE_LENGTH).toBe(6);
    for (const confusable of ['I', 'O', '0', '1']) {
      expect(ROOM_CODE_ALPHABET).not.toContain(confusable);
    }
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(ROOM_CODE_ALPHABET.length);
  });
});

describe('parseClientMessage', () => {
  it('rejects anything that is not a text frame', () => {
    expect(expectRejected(new ArrayBuffer(4))).toContain('text');
    expect(expectRejected(42)).toContain('text');
  });

  it('rejects oversized frames without parsing them', () => {
    const huge = encode({ t: 'hello', v: 1, name: 'A'.repeat(MAX_MESSAGE_BYTES) });
    expect(huge.length).toBeGreaterThan(MAX_MESSAGE_BYTES);
    expect(expectRejected(huge)).toContain('too large');
  });

  it('rejects malformed JSON and non-object frames', () => {
    expect(expectRejected('{')).toContain('malformed');
    expect(expectRejected('[]')).toContain('object');
    expect(expectRejected('null')).toContain('object');
    expect(expectRejected('"hello"')).toContain('object');
  });

  it('rejects unknown and missing message types', () => {
    expect(expectRejected(encode({ t: 'shutdown' }))).toContain('unknown message type');
    expect(expectRejected(encode({}))).toContain('unknown message type');
    expect(expectRejected(encode({ t: '__proto__' }))).toContain('unknown message type');
  });

  it('accepts a minimal hello and normalises the name', () => {
    const result = parseClientMessage(encode({ t: 'hello', v: 1, name: '  Maya  ' }));
    expect(result).toEqual({ ok: true, value: { t: 'hello', v: 1, name: 'Maya' } });
  });

  it('drops unknown extra properties instead of forwarding them', () => {
    const result = parseClientMessage(encode({ t: 'hello', v: 1, name: 'Maya', isAdmin: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.value).sort()).toEqual(['name', 't', 'v']);
  });

  it('rejects hello with a bad name or missing version', () => {
    expect(expectRejected(encode({ t: 'hello', v: 1, name: '' }))).toContain('name');
    expect(expectRejected(encode({ t: 'hello', v: 1, name: 'A'.repeat(21) }))).toContain('name');
    expect(expectRejected(encode({ t: 'hello', name: 'Maya' }))).toContain('v');
  });

  it('only accepts resume credentials as a matched, well-formed pair', () => {
    const good = { t: 'hello', v: 1, name: 'Maya', playerId: 'abcdef1234', token: 'fedcba4321' };
    expect(parseClientMessage(encode(good)).ok).toBe(true);
    expect(expectRejected(encode({ ...good, token: undefined }))).toContain('resume');
    expect(expectRejected(encode({ ...good, playerId: 'short' }))).toContain('resume');
    expect(expectRejected(encode({ ...good, token: 'has spaces!!' }))).toContain('resume');
    expect(expectRejected(encode({ ...good, playerId: 'x'.repeat(65) }))).toContain('resume');
    expect(expectRejected(encode({ ...good, playerId: 123456789 }))).toContain('resume');
  });

  it('accepts a well-formed claim', () => {
    const result = parseClientMessage(encode({ t: 'claim', cards: [0, 40, 80], boardVersion: 3 }));
    expect(result).toEqual({
      ok: true,
      value: { t: 'claim', cards: [0, 40, 80], boardVersion: 3 },
    });
  });

  it('rejects claims with the wrong shape, bad ids, duplicates or a bad version', () => {
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1], boardVersion: 1 }))).toContain('3');
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, 2, 3], boardVersion: 1 }))).toContain(
      '3',
    );
    expect(expectRejected(encode({ t: 'claim', cards: 'abc', boardVersion: 1 }))).toContain('3');
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, 81], boardVersion: 1 }))).toContain(
      'card ids',
    );
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, -1], boardVersion: 1 }))).toContain(
      'card ids',
    );
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, 1.5], boardVersion: 1 }))).toContain(
      'card ids',
    );
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, '2'], boardVersion: 1 }))).toContain(
      'card ids',
    );
    expect(expectRejected(encode({ t: 'claim', cards: [5, 5, 5], boardVersion: 1 }))).toContain(
      'distinct',
    );
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, 2] }))).toContain('boardVersion');
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, 2], boardVersion: -1 }))).toContain(
      'boardVersion',
    );
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, 2], boardVersion: 1.5 }))).toContain(
      'boardVersion',
    );
    expect(expectRejected(encode({ t: 'claim', cards: [0, 1, 2], boardVersion: 1e12 }))).toContain(
      'boardVersion',
    );
  });

  it('accepts and validates the remaining message types', () => {
    for (const t of ['start', 'rematch', 'leave', 'ping']) {
      expect(parseClientMessage(encode({ t }))).toEqual({ ok: true, value: { t } });
    }
  });

  it('no longer accepts a "no SET" call, which the server now decides itself', () => {
    expect(expectRejected(encode({ t: 'noSet', boardVersion: 0 }))).toContain('unknown message');
  });

  it('accepts a request for more cards, either way round', () => {
    for (const want of [true, false]) {
      expect(parseClientMessage(encode({ t: 'deal', want, boardVersion: 4 }))).toEqual({
        ok: true,
        value: { t: 'deal', want, boardVersion: 4 },
      });
    }
  });

  it('rejects a request for more cards with a missing or non-boolean intent', () => {
    expect(expectRejected(encode({ t: 'deal', boardVersion: 1 }))).toContain('want');
    // A truthy string must not be coerced into a vote.
    expect(expectRejected(encode({ t: 'deal', want: 'yes', boardVersion: 1 }))).toContain('want');
    expect(expectRejected(encode({ t: 'deal', want: 1, boardVersion: 1 }))).toContain('want');
    expect(expectRejected(encode({ t: 'deal', want: true }))).toContain('boardVersion');
  });

  it('accepts only the two hint levels that exist', () => {
    for (const level of [1, 2]) {
      expect(parseClientMessage(encode({ t: 'hint', level, boardVersion: 2 }))).toEqual({
        ok: true,
        value: { t: 'hint', level, boardVersion: 2 },
      });
    }
    for (const level of [0, 3, -1, 1.5, '1', null]) {
      expect(expectRejected(encode({ t: 'hint', level, boardVersion: 2 }))).toContain('level');
    }
    expect(expectRejected(encode({ t: 'hint', level: 1 }))).toContain('boardVersion');
  });
});
