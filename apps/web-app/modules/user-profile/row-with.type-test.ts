// Type guarantees of `RowWith`, the row of a table with relations loaded — compiled by `pnpm typecheck`, never run.
import { expectTypeOf } from 'vitest';
import type { Row, RowWith } from '@marmeon/database';
import type { UserRepository } from '../auth/UserRepository.ts';

declare const users: UserRepository;

export async function rowWithTypes() {
  expectTypeOf(await users.findOrFail(1, { with: ['profile_links'] })).toEqualTypeOf<RowWith<'users', 'profile_links'>>();
  expectTypeOf<RowWith<'users', 'profile_links'>['profile_links'][number]['user_id']>().toEqualTypeOf<number>();
  expectTypeOf<RowWith<'users', 'profile_links'>['email']>().toEqualTypeOf<Row<'users'>['email']>();
  // @ts-expect-error — users has no relation "profiles"
  type Wrong = RowWith<'users', 'profiles'>;
  return undefined as unknown as Wrong;
}
