/**
 * Translation layer.
 *
 * Hebrew is the default; English is available from the language switch. The UI
 * contains no literal display text, so adding a third language means adding one
 * dictionary below and nothing else. A right-to-left language sets `meta.dir` to
 * `rtl` in its own dictionary, and the shell applies that to `<html dir>`.
 */

import { en, type StringKey } from './en.js';
import { he } from './he.js';

export type { StringKey };

/** Registered locales. Keys are checked against English at compile time. */
const LOCALES = {
  he,
  en,
} satisfies Record<string, Record<StringKey, string>>;

export type Locale = keyof typeof LOCALES;

export const LOCALES_AVAILABLE = Object.keys(LOCALES) as Locale[];
export const DEFAULT_LOCALE: Locale = 'he';

/** Each language named in itself, for the switch. */
export const LOCALE_NAMES: Record<Locale, string> = {
  he: 'עברית',
  en: 'English',
};

const STORAGE_KEY = 'set.locale';

let current: Locale = DEFAULT_LOCALE;

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && value in LOCALES;
}

/** Switch locale and remember the choice. */
export function setLocale(locale: Locale): void {
  current = locale;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, locale);
  } catch {
    // Storage can be unavailable; the choice simply will not persist.
  }
}

export function getLocale(): Locale {
  return current;
}

/**
 * Restore the remembered locale, else use the default. Called once at start-up.
 *
 * Deliberately does **not** consult `navigator.language`. This game is for a
 * Hebrew-speaking table, and a browser set to English — which is most phones sold
 * here — would otherwise hand a Hebrew speaker an English board. The switch is
 * one tap away and the choice is remembered, so guessing from the browser buys
 * nothing and gets it wrong more often than right. (Same rule as the owner's
 * SuperTaki project, which is stored-choice-else-Hebrew.)
 */
export function initLocale(): Locale {
  let stored: string | null = null;
  try {
    stored = globalThis.localStorage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    stored = null;
  }
  current = isLocale(stored) ? stored : DEFAULT_LOCALE;
  return current;
}

/** Text direction of the active locale, for `<html dir>`. */
export function direction(): 'ltr' | 'rtl' {
  const dir: string = LOCALES[current]['meta.dir'];
  return dir === 'rtl' ? 'rtl' : 'ltr';
}

export type Params = Record<string, string | number>;

/**
 * Look up `key` and substitute `{placeholder}` values.
 *
 * Falls back to English then to the key itself, so a missing string shows up in
 * development rather than rendering as empty. Substituted values are inserted as
 * plain text by every caller, so no HTML escaping is involved anywhere.
 */
export function t(key: StringKey, params?: Params): string {
  const template = LOCALES[current][key] || en[key] || key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
