import { withCode } from '@marmeon/core/internal';
import { UnsupportedDriverError } from './supported-driver.ts';

/** Throws for a feature that has no MySQL form yet: the driver is named in the types, but a connection cannot select it. */
export function mysqlPending(feature: string): never {
  throw new UnsupportedDriverError(withCode('D29', `${feature} does not run on MySQL yet.`));
}
