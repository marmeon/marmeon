import type { CommandInput } from '@bespokecore/cli';
import { environment } from '@bespokecore/core';

/**
 * Destructive commands ask for `--force` wherever the app is protected (E139, E164): every `NODE_ENV` but `development` and
 * `test` — staging and a missing `NODE_ENV` too, like Laravel's confirmation in production. Each names the environment it
 * assumed.
 */
export function confirmed({ options, output }: CommandInput, what: string): boolean {
  output.line(`Environment: ${environment.describe()}`);
  if (!environment.isProtected() || options.force === true) return true;
  output.error(`The application is protected (${environment.describe()}). Pass --force to ${what} — or, on a development machine, set NODE_ENV=development.`);
  return false;
}
