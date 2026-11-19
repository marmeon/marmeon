import type { Connection, Connections } from '@marmeon/database';
import { requireDriver } from '@marmeon/database/internal';

/** The database drivers the stores of authentication (sign-ins, tokens, resets, email changes, factors, passkeys) are written for. */
export const AUTH_STORE_DRIVERS = ['sqlite', 'pgsql'] as const;

/**
 * The default connection for a database store of this package, once its driver is one the stores run on: otherwise the store refuses
 * (`UnsupportedDriverError`) before the connection is opened. Package-internal.
 */
export function storeDatabase<Tables>(connections: Connections, what: string): Connection<Tables> {
  requireDriver(connections.options().driver, AUTH_STORE_DRIVERS, { what });
  return connections.get<Tables>();
}
