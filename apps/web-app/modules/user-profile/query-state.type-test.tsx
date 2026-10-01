/**
 * Type guarantees of the query schema (E55) against this app's people list — checked by `tsc` (`pnpm typecheck`,
 * `bespoke build`), never run. Each `@ts-expect-error` is a mistake an app developer makes; the comment above it is
 * the message they get (read with the directive removed).
 */
import type { QueryOf } from '@bespokecore/http';
import { Link, useQueryState, useRoute } from '@bespokecore/react';
import { expectTypeOf } from 'vitest';
import type { ListPeopleController } from './controllers/ListPeopleController.ts';

export function OnThePeoplePage() {
  const [query, setQuery] = useQueryState('user-profile.people', { only: ['people'], debounce: 300, history: 'replace' });
  // The parsed query, defaults filled in — what the controller's ctx.query is.
  expectTypeOf(query).toEqualTypeOf<QueryOf<ListPeopleController>>();
  expectTypeOf(query).toEqualTypeOf<{ q: string; sort: 'name' | '-name' | 'joined' | '-joined'; cursor?: string | undefined }>();
  setQuery({ q: 'ada', cursor: undefined });
  setQuery((current) => ({ sort: current.sort === 'name' ? '-name' : 'name' }));
  const route = useRoute();
  void route('user-profile.people', {}, { sort: '-joined', q: 'ada' });

  // Type '"nme"' is not assignable to type '"-joined" | "-name" | "joined" | "name" | undefined'. Did you mean '"name"'?
  // @ts-expect-error
  setQuery({ sort: 'nme' });
  // Object literal may only specify known properties, and 'srot' does not exist in type 'QueryUpdate<{ q: string; sort: …; cursor?: … }>'.
  // @ts-expect-error
  setQuery({ srot: 'name' });
  // Type '"stats"' is not assignable to type '"auth" | "errors" | "flash" | "locales" | "now" | "people"'.
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
      <Link route="user-profile.people" query={{ ...query, sort: '-name' }} only={['people']} reset={['people']} preserveState>
        Name ↓
      </Link>
      {/* Type '"nme"' is not assignable to type '"-joined" | "-name" | "joined" | "name" | undefined'. Did you mean '"name"'? */}
      {/* @ts-expect-error */}
      <Link route="user-profile.people" query={{ sort: 'nme' }}>
        Name
      </Link>
      {/* Object literal may only specify known properties, and 'page' does not exist in type 'QueryFields<{ q: string; sort: …;
          cursor?: string | undefined; }>'. */}
      {/* @ts-expect-error */}
      <Link route="user-profile.people" query={{ page: 2 }}>
        Page 2
      </Link>
      {/* A route without a query schema takes any query (no break). */}
      <Link route="user-profile.show" params={{ user: 7 }} query={{ tab: 'links' }}>
        Links
      </Link>
    </>
  );
}
