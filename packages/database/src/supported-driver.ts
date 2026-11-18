import { withCode } from '@marmeon/core/internal';
import type { ConnectionOptions } from './config.ts';

/** A package that keeps SQL of its own was given a connection of a database driver it has none for. */
export class UnsupportedDriverError extends Error {
  override name = 'UnsupportedDriverError';
}

/**
 * Returns `driver` when `supported` names it exactly, and otherwise throws an `UnsupportedDriverError` that names the drivers the
 * feature runs on. A package calls it where a store takes its connection (before the connection is opened), and at start where
 * the setting surely uses the database, so a driver it has no SQL for never falls into the branch of another one.
 * @internal
 */
export function requireDriver<const S extends readonly ConnectionOptions['driver'][]>(driver: string, supported: S, feature: { readonly what: string; readonly instead?: string }): S[number] {
  if ((supported as readonly string[]).includes(driver)) return driver as S[number];
  const next = feature.instead === undefined ? '' : `; ${feature.instead}`;
  throw new UnsupportedDriverError(withCode('D29', `${feature.what} needs a ${supported.join(' or ')} connection, not ${JSON.stringify(driver)}${next}.`));
}

/** The message for a driver that the types do not name: a connection built around `defineConnection`, or a cast, can carry one. */
export function unknownDriverMessage(driver: unknown): string {
  return withCode('D29', `The database driver ${JSON.stringify(driver)} is not one Marmeon knows; use sqlite or pgsql.`);
}

/**
 * The `default` of a `switch` over the drivers: the compiler proves it unreachable for the drivers the types name, and a value from outside
 * the types (a JavaScript caller, a cast) is refused here instead of falling into the branch of another driver.
 * @internal
 */
export function unknownDriver(value: never): never {
  // A connection's options carry the driver; a branch over the driver alone passes it.
  const given: unknown = value;
  const driver = typeof given === 'object' && given !== null && 'driver' in given ? given.driver : given;
  throw new UnsupportedDriverError(unknownDriverMessage(driver));
}
