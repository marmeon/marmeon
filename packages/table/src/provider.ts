import { Gate } from '@bespokecore/auth';
import type { Container, ServiceProvider } from '@bespokecore/core';
import { Database } from '@bespokecore/database';
import { Encrypter } from '@bespokecore/encryption';
import { Router } from '@bespokecore/router';
import { Tables } from './tables.ts';

/** Binds `Tables` per request — its policies are the request user's (the request's `Gate`). */
export class TableServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.scoped(
      Tables,
      (scope) =>
        new Tables(
          scope.make(Database),
          // Asked only when a table names a policy, a cursor is encrypted: a table without them needs neither.
          () => scope.make(Gate),
          (Class) => scope.make(Class),
          scope.make(Router),
          () => scope.make(Encrypter),
        ),
    );
  }
}
