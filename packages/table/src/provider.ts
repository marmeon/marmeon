import { Gate } from '@marmeon/auth';
import { Clock, Translator, type Application, type Container, type ServiceProvider } from '@marmeon/core';
import { Connections, Database } from '@marmeon/database';
import { Encrypter } from '@marmeon/encryption';
import { Router } from '@marmeon/router';
import { DataTables, distinctRegistrations } from './tables.ts';

/** Binds `DataTables` per request — its policies are the request user's (the request's `Gate`). */
export class TableServiceProvider implements ServiceProvider {
  /** The start fails when one table is registered twice under the same URLs. */
  boot(app: Application): void {
    app.container.make(Router).checkRoutes(distinctRegistrations());
  }

  register(container: Container): void {
    container.scoped(
      DataTables,
      (scope) =>
        new DataTables(
          scope.make(Database),
          // Asked only when a table names a policy, a cursor is encrypted: a table without them needs neither.
          () => scope.make(Gate),
          (Class) => scope.make(Class),
          () => scope.make(Encrypter),
          // The schema's relations and columns, to check a `filter.has()` against: read when the table is first used.
          () => scope.make(Connections).metadata(),
          // The request's language for labels and the delimiter: none without `@marmeon/i18n`.
          () => (container.has(Translator) ? scope.make(Translator) : undefined),
          // The app's time, for the day in an export's file name.
          () => scope.make(Clock),
        ),
    );
  }
}
