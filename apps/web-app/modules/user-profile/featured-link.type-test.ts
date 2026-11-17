// Type guarantees of the featured link — compiled by `pnpm typecheck`, never run.
import { expectTypeOf } from 'vitest';
import type { RowWith } from '@marmeon/database';

// A partial unique index on `user_id` (one featured link per user) keeps the relation a list: a user still has many links.
export function linksRelationIsAList() {
  expectTypeOf<RowWith<'users', 'profile_links'>['profile_links']>().toBeArray();
}
