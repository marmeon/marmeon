import { createRequire } from 'node:module';
import type * as Oxc from 'oxc-parser';

let oxc: typeof Oxc | undefined;

/**
 * oxc-parser's `parseSync`, loaded on the first call. The injection analysis and the discovery's declaration reader
 * parse only when there is something to derive — a start from `marmeon build`'s injection lists and an up-to-date discovery
 * manifest never imports oxc-parser (its native binding and ~7 modules). Synchronous on purpose: the load hook
 * (`@marmeon/core/register`) cannot await.
 */
export function parseSync(...args: Parameters<typeof Oxc.parseSync>): ReturnType<typeof Oxc.parseSync> {
  oxc ??= createRequire(import.meta.url)('oxc-parser') as typeof Oxc;
  return oxc.parseSync(...args);
}
