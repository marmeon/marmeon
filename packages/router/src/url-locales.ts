import { token } from '@marmeon/core';
import type { HttpContext } from './types.ts';

/**
 * The locales a URL can name, and the one a request prefers when its URL names none — what `Route.localized()` needs from
 * `@marmeon/i18n`, which binds it. The router and the server see only this contract.
 */
export interface UrlLocales {
  /** The locales of the app, each in the spelling its URL uses (`en`, `de-AT`). */
  readonly supported: readonly string[];
  /** The preferred locale of a request: always one of `supported`. */
  preferred(ctx: HttpContext): Promise<string>;
}
export const UrlLocales = token<UrlLocales>('UrlLocales');
