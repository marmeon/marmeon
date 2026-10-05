/**
 * Type guarantees of prefetching, polling, `<WhenVisible>` and merging (W5 step 6) against this app's profile page —
 * checked by `tsc` (`pnpm typecheck`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the
 * comment above it is the message they get (read with the directive removed).
 */
import { deepMerge, defer, merge } from '@bespokecore/http';
import { Link, usePoll, useRouter, WhenVisible } from '@bespokecore/react';
import type { ShowUserProfileController } from './controllers/ShowUserProfileController.ts';

export function OnTheProfilePage() {
  const router = useRouter<ShowUserProfileController>();
  void router.prefetch('/users/7');
  void router.prefetch('/users/7', { cacheFor: 60_000, data: { q: 'ada' } });
  void router.reload({ data: { tab: 'links' }, only: ['stats'], preserveUrl: true, async: true });
  usePoll<ShowUserProfileController>(15_000, { only: ['activity'] });
  usePoll(15_000, {}, { keepAlive: true, autoStart: false });

  // A prefetch is always a GET: Object literal may only specify known properties, and 'method' does not exist in type 'PrefetchOptions'.
  // @ts-expect-error
  void router.prefetch('/logout', { method: 'post' });
  // Type '"activty"' is not assignable to type '"activity" | "auth" | … | "stats"'. Did you mean '"activity"'?
  // @ts-expect-error
  usePoll<ShowUserProfileController>(15_000, { only: ['activty'] });

  return (
    <>
      <Link route="user-profile.show" params={{ user: 7 }} prefetch>
        Grace
      </Link>
      <Link route="user-profile.show" params={{ user: 7 }} prefetch={['hover', 'mount']} cacheFor={10_000}>
        Grace
      </Link>
      <Link href="/users/7" prefetch="mount">
        Grace
      </Link>
      {/* A DELETE route is an action, never prefetched:
          Type 'true' is not assignable to type '"only links (GET) are prefetched — never an action (POST, PUT, PATCH, DELETE)"'. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.links.destroy" params={{ user: 7, link: 1 }} prefetch>
        Remove
      </Link>
      {/* Type '{ href: string; method: "post"; prefetch: true; … }' is not assignable to type 'IntrinsicAttributes & HrefLinkProps'.
            Types of property 'prefetch' are incompatible. Type 'true' is not assignable to type '"only links (GET) are prefetched — …"'. */}
      {/* @ts-expect-error */}
      <Link href="/logout" method="post" prefetch>
        Sign out
      </Link>
      {/* Type '"click"' is not assignable to type 'boolean | readonly PrefetchTrigger[] | PrefetchTrigger | undefined'. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.show" params={{ user: 7 }} prefetch="click">
        Grace
      </Link>
      <WhenVisible<ShowUserProfileController> data="stats" buffer={100} fallback="…">
        {() => 'ready'}
      </WhenVisible>
      <WhenVisible<ShowUserProfileController> always params={{ data: { tab: 'links' }, only: ['stats'], preserveUrl: true }} />
      {/* Type '"stat"' is not assignable to type '"activity" | … | "stats" | readonly (…)[] | undefined'. Did you mean '"stats"'? */}
      {/* @ts-expect-error */}
      <WhenVisible<ShowUserProfileController> data="stat">ready</WhenVisible>
      {/* Type '"activty"' is not assignable to type '…'. Did you mean '"activity"'? */}
      {/* @ts-expect-error */}
      <WhenVisible<ShowUserProfileController> params={{ only: ['activty'] }} />
    </>
  );
}

const people = { data: [{ id: 1, name: 'Ada' }], meta: { nextCursor: null as string | null } };
export const props = {
  others: deepMerge(() => people).matchOn('data.id'),
  links: merge([{ id: 1, url: 'https://example.com' }]).matchOn('id'),
  feed: defer(() => [{ id: 1 }]).merge().matchOn('id'),
  // Argument of type '"data.uid"' is not assignable to parameter of type '"data.id" | "data.name"'.
  // @ts-expect-error
  badPath: deepMerge(() => people).matchOn('data.uid'),
  // Argument of type '"uid"' is not assignable to parameter of type '"id" | "url"'.
  // @ts-expect-error
  badKey: merge([{ id: 1, url: 'x' }]).matchOn('uid'),
  // merge() appends a top-level array, or a paginator's data (W9) — its items' keys under `data.`:
  shallow: merge(people).matchOn('data.id'),
  // Argument of type '"data.uid"' is not assignable to parameter of type '"data.id" | "data.name"'.
  // @ts-expect-error
  shallowBadKey: merge(people).matchOn('data.uid'),
  // Only a merging deferred prop matches: Property 'matchOn' does not exist on type 'DeferredProp<{ id: number; }[]>'.
  // @ts-expect-error
  deferNoMerge: defer(() => [{ id: 1 }]).matchOn('id'),
};
