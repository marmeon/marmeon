// Type guarantees of `credentialWriter()` — checked by `tsc` (typecheck), never run.
import type { Connection } from '@marmeon/database';
import { expectTypeOf } from 'vitest';
import { credentialWriter, type CredentialWriter } from './credential-writer.ts';
import type { PasswordHash } from './hashing.ts';
import type { AuthUser } from './user.ts';

interface NumberedUser {
  readonly id: number;
}
interface NamedUser {
  readonly id: string;
}

export async function credentialWriterTypes(db: Connection<any>, hash: PasswordHash) {
  const numbered = credentialWriter<NumberedUser>(db, { table: 'office_users' });
  expectTypeOf(numbered).toEqualTypeOf<CredentialWriter<NumberedUser>>();
  await numbered.updatePasswordHash(1, hash);
  await numbered.updateSessionKey(1, 'k'.repeat(32), null);
  // @ts-expect-error the id of a `NumberedUser` is a number
  await numbered.updatePasswordHash('1', hash);
  // @ts-expect-error the id of a `NumberedUser` is a number
  await numbered.updateSessionKey('1', 'k'.repeat(32), null);

  const named = credentialWriter<NamedUser>(db, { table: 'named_users' });
  await named.updatePasswordHash('a', hash);
  // @ts-expect-error the id of a `NamedUser` is a string
  await named.updatePasswordHash(1, hash);
  expectTypeOf((await named.updateEverySessionKey('k'.repeat(32))).sampleId).toEqualTypeOf<string | undefined>();

  // Without a type argument it is the app's user, on its table or one of yours.
  credentialWriter(db);
  credentialWriter(db, { table: 'accounts' });
  expectTypeOf(credentialWriter(db, { table: 'accounts' })).toEqualTypeOf<CredentialWriter<AuthUser>>();
  // @ts-expect-error a named user type needs its own table: the default one is the app's
  credentialWriter<NumberedUser>(db);
  // @ts-expect-error a named user type needs its own table: the default one is the app's
  credentialWriter<NumberedUser>(db, {});
  // @ts-expect-error a user needs an `id`
  credentialWriter<{ readonly name: string }>(db, { table: 'office_users' });
  expectTypeOf(credentialWriter(db)).toEqualTypeOf<CredentialWriter<AuthUser>>();
  expectTypeOf<CredentialWriter>().toEqualTypeOf<CredentialWriter<AuthUser>>();
}
