import type { Container } from '@marmeon/core';
import { INTENDED_KEY, IntendedKey } from '@marmeon/http/internal';
import { Session } from '@marmeon/session';
import { guardNames } from './guard-names.ts';
import { RequestGuard } from './guard-stamp.ts';
import { guardsThatActed } from './session-keys.ts';

/** The key of `guard`'s wished page: the app's (`web`) or a package guard's. */
const keyOf = (guard: string): string => (guard === 'web' ? INTENDED_KEY : guardNames(guard).session.intended);

/**
 * Binds the session key `redirect().intended()` reads, once: whichever provider needs it first. It is the key of the guard that
 * completed a sign-in, a password confirmation or a second factor on this request, whatever middleware the route has; two guards
 * that did read none (the redirect takes its fallback). Where none did, it is the route's stamp's: on a package guard's route only
 * that guard's page is followed, on any other route only the app's. A getter, so it is read when the redirect is made. @internal
 */
export function bindIntendedKey(container: Container): void {
  if (container.has(IntendedKey)) return;
  container.scoped(IntendedKey, (c) => ({
    get key(): string | null {
      const acted = guardsThatActed(c.make(Session));
      if (acted.size > 1) return null;
      const [only] = acted;
      if (only !== undefined) return keyOf(only);
      const route = c.make(RequestGuard);
      return route.servesGuard('web') ? INTENDED_KEY : keyOf(route.name!);
    },
  }));
}
