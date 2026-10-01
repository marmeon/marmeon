import { token } from './token.ts';

/**
 * The translation contract — like {@link Logger}: framework packages depend on this, never on the translation
 * package. `@bespokecore/i18n` binds it **per request** (the request's locale, no global state); without it, nothing
 * is bound and framework texts stay in English (their `fallback`).
 *
 * Apps use the typed `Translator` of `@bespokecore/i18n` (the same token, with checked keys and placeholders).
 */
export interface Translator {
  /** The locale this translator speaks, e.g. `de` — always one of the app's supported locales. */
  readonly locale: string;
  /** Whether `key` (`namespace.path`) has a message in this locale or the fallback locale. */
  has(key: string): boolean;
  /**
   * `key`'s message with its placeholders filled in — in this locale, else the fallback locale; when neither has
   * it, `fallback` (filled in the same way), else the key itself. Always plain text: render it as text, never as HTML.
   */
  text(key: string, params?: Readonly<Record<string, unknown>>, fallback?: string): string;
}
export const Translator = token<Translator>('Translator');

/**
 * `{name}` placeholders filled from `params` — for framework texts while no translator is bound (no plural or
 * select: those need `@bespokecore/i18n`). Unknown placeholders stay as they are.
 */
export function fillPlaceholders(text: string, params: Readonly<Record<string, unknown>> = {}): string {
  return text.replace(/\{([\w-]+)\}/g, (match, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : match));
}
