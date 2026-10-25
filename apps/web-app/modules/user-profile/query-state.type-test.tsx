/**
 * Type guarantees of the query schema against this app's people list — checked by `tsc` (`pnpm typecheck`,
 * `marmeon build`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the comment above it is
 * the message they get (read with the directive removed).
 */
import type { QueryOf } from '@marmeon/http';
import { Link, useQueryState, useRoute } from '@marmeon/react';
import { expectTypeOf } from 'vitest';
import type { ListPeopleController } from './controllers/ListPeopleController.ts';

export function OnThePeoplePage() {
  const [query, setQuery] = useQueryState('user-profile.people', { only: ['people'], debounceMs: 300, history: 'replace' });
  // The parsed query, defaults filled in — what the controller's ctx.query is.
  expectTypeOf(query).toEqualTypeOf<QueryOf<ListPeopleController>>();
  expectTypeOf(query).toEqualTypeOf<{ q: string; sort: 'name' | '-name' | 'joined' | '-joined'; page: number; per_page: 10 | 25 | 50 }>();
  setQuery({ q: 'ada', page: undefined });
  setQuery((current) => ({ sort: current.sort === 'name' ? '-name' : 'name' }));
  const route = useRoute();
  void route('user-profile.people', {}, { sort: '-joined', q: 'ada' });

  // Type '"nme"' is not assignable to type '"-joined" | "-name" | "joined" | "name" | undefined'. Did you mean '"name"'?
  // @ts-expect-error
  setQuery({ sort: 'nme' });
  // Object literal may only specify known properties, and 'srot' does not exist in type 'QueryUpdate<{ page: number; per_page: 10 | 25 | 50; q: string; sort: …; }>'.
  // @ts-expect-error
  setQuery({ srot: 'name' });
  // The unit is in the name: Object literal may only specify known properties, and 'debounce' does not exist in type '…'. Did you mean 'debounceMs'?
  // @ts-expect-error
  useQueryState('user-profile.people', { only: ['people'], debounce: 300 });
  // Type '"stats"' is not assignable to type '"auth" | "bell" | "errors" | "locales" | "now" | "people"'.
  // @ts-expect-error
  useQueryState('user-profile.people', { only: ['stats'] });
  // Argument of type '"user-profile.show"' is not assignable to parameter of type '"'user-profile.show' has no query schema to keep
  // state in — give its controller `static request = defineRequest({ query })`"'.
  // @ts-expect-error
  useQueryState('user-profile.show');
  // Type '"nme"' is not assignable to type '"-joined" | "-name" | "joined" | "name" | undefined'. Did you mean '"name"'?
  // @ts-expect-error
  void route('user-profile.people', {}, { sort: 'nme' });

  return (
    <>
      <Link route="user-profile.people" query={{ ...query, sort: '-name', page: 1 }} only={['people']} preserveState>
        Name ↓
      </Link>
      {/* Type '"nme"' is not assignable to type '"-joined" | "-name" | "joined" | "name" | undefined'. Did you mean '"name"'? */}
      {/* @ts-expect-error */}
      <Link route="user-profile.people" query={{ sort: 'nme' }}>
        Name
      </Link>
      {/* The page is a field of the schema now (pageQuery()): typed like the rest. */}
      <Link route="user-profile.people" query={{ page: 2, per_page: 25 }}>
        Page 2
      </Link>
      {/* Type '30' is not assignable to type '10 | 25 | 50 | undefined'. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.people" query={{ per_page: 30 }}>
        30 a page
      </Link>
      {/* Object literal may only specify known properties, and 'cursor' does not exist in type 'QueryFields<{ page: number; per_page: 10 |
          25 | 50; q: string; sort: "-joined" | "-name" | "joined" | "name"; }>'. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.people" query={{ cursor: 'x' }}>
        More
      </Link>
      {/* A route without a query schema takes any query (no break). */}
      <Link route="user-profile.show" params={{ user: 7 }} query={{ tab: 'links' }}>
        Links
      </Link>
    </>
  );
}
