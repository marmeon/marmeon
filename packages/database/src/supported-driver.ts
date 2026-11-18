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
