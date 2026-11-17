import { withCode } from '@marmeon/core/internal';
import { parseRange } from './addresses.ts';
import { FetchSetupError } from './errors.ts';

/** The ranges `FETCH_ALLOWED_ADDRESSES` names; an entry that is not a range is a `FetchSetupError` (S9). */
export function allowedRanges(entries: readonly string[]): readonly string[] {
  for (const entry of entries) {
    try {
      parseRange(entry);
    } catch (error) {
      throw new FetchSetupError(withCode('S9', `FETCH_ALLOWED_ADDRESSES has an entry that is not an address range. ${(error as Error).message}`));
    }
  }
  return entries;
}
