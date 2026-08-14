/**
 * Minimal translation layer.
 *
 * The UI never contains literal display text; it calls `t('some.key')`. Adding a
 * locale means adding one dictionary to `LOCALES` and, for right-to-left
 * languages, setting `meta.dir` to `rtl` in that dictionary — the shell applies
 * `dir` to `<html>` from it.
 */

import { en, type StringKey } from './en.js';

export type { StringKey };

/** Registered locales. Add new dictionaries here; keys are checked at compile time. */
const LOCALES = {
  en,
} satisfies Record<string, Record<StringKey, string>>;

export type Locale = keyof typeof LOCALES;

let current: Locale = 'en';

/**
 * Switch locale. The extension point for adding a language: register the
 * dictionary in `LOCALES` above, call this once at start-up, and re-render.
 */
export function setLocale(locale: Locale): void {
  current = locale;
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
 * Substituted values are inserted as plain text by the caller (every consumer
 * assigns to `textContent`), so no HTML escaping is involved anywhere.
 */
export function t(key: StringKey, params?: Params): string {
  const template = LOCALES[current][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}
