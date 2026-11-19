import { withCode } from '@marmeon/core/internal';
import type { ConnectionOptions } from './config.ts';
import { UnsupportedDriverError } from './supported-driver.ts';

/** Throws for a feature that has no MySQL form yet: the driver is named in the types, but an app cannot select it. */
export function mysqlPending(feature: string): never {
  throw new UnsupportedDriverError(withCode('D29', `${feature} does not run on MySQL yet.`));
}

/**
 * Keeps the door to MySQL shut for an app: `DatabaseServiceProvider` calls it for every connection before the connections are built,
 * whichever way the options came (a definition built by hand, an override of the default). A `Connections` built directly takes MySQL.
 */
export function refuseUnselectableMysql(name: string, options: ConnectionOptions): void {
  if (options.driver === 'mysql') throw new UnsupportedDriverError(withCode('D29', `The connection "${name}" names the driver "mysql"; use sqlite or pgsql.`));
}
