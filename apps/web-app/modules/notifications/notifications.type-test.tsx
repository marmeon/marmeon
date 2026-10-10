/**
 * Type guarantees of the merged, paginated list against this app's notifications — checked by `tsc` (`pnpm typecheck`,
 * `marmeon build`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the comment above it is the message
 * they get (read with the directive removed).
 */
import { Pagination, useRouter } from '@marmeon/react';
import { expectTypeOf } from 'vitest';
import type { ShowNotificationsController } from './controllers/ShowNotificationsController.ts';

export function MergedList() {
  const router = useRouter<ShowNotificationsController>();
  // A reload after an action replaces what it brings — `reset` names fewer props, `reset: []` keeps merging them (appending).
  router.reloading({ only: ['notifications', 'bell'] });
  router.reloading({ only: ['notifications'], reset: [] });
  // Type '"notifcations"' is not assignable to type '"auth" | "bell" | "errors" | "locales" | "notifications"'. Did you mean '"notifications"'?
  // @ts-expect-error
  router.reloading({ only: ['notifications'], reset: ['notifcations'] });
  // "Load more" keeps appending: a visit with a query (the cursor), not a revalidation.
  void router.reload({ data: { cursor: 'c' }, only: ['notifications'], preserveUrl: true });

  const meta = { page: 1, perPage: 10, total: 30, lastPage: 3, from: 1, to: 10 };
  expectTypeOf<Parameters<typeof Pagination>[0]['labels']>().toEqualTypeOf<
    Partial<{ readonly navigation: string; readonly previous: string; readonly next: string; readonly page: (page: number) => string }> | undefined
  >();
  return (
    <>
      <Pagination meta={meta} labels={{ next: 'Suivant' }} />
      {/* Object literal may only specify known properties, but 'nxt' does not exist in type 'Partial<PaginationLabels>'. Did you mean to write 'next'? */}
      {/* @ts-expect-error */}
      <Pagination meta={meta} labels={{ nxt: 'Suivant' }} />
    </>
  );
}
