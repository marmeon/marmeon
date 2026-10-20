import type { AnyMiddleware } from './types.ts';

/**
 * What a middleware promises about the requests it lets through, for `marmeon check` to read: `authenticated` — only a known
 * user, or the holder of a signed link, gets past; `rate-limited` — it answers 429 when too many requests come. Declare it on
 * the class as `static ensures = ['rate-limited'] as const`; it is read by `marmeon check`, never at runtime, and it is the
 * middleware's word, not something the check verifies. See docs/middleware.md#declaring-what-a-middleware-ensures.
 */
export type MiddlewareEnsures = 'authenticated' | 'rate-limited';

const KNOWN: readonly string[] = ['authenticated', 'rate-limited'];

/**
 * The promises `middleware` declares in `ensures` (a class or an object). Only an array counts, and only its known strings:
 * `'rate-limited'` alone or `['trusted']` declares nothing.
 *
 * @internal
 */
export function ensuresOf(middleware: AnyMiddleware): readonly MiddlewareEnsures[] {
  let declared: unknown;
  try {
    declared = (middleware as { ensures?: unknown } | null | undefined)?.ensures;
  } catch {
    return [];
  }
  if (!Array.isArray(declared)) return [];
  return declared.filter((entry): entry is MiddlewareEnsures => typeof entry === 'string' && KNOWN.includes(entry));
}
