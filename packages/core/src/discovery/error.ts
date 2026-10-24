import { withCode } from '../error-codes.ts';
import { printable } from './resolve.ts';

export class DiscoveryError extends Error {
  override name = 'DiscoveryError';

  /** The message may quote text of a foreign package (a parameter, a file name): it is written with control characters escaped. */
  constructor(message: string) {
    super(withCode('K7', printable(message)));
  }
}
