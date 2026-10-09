import type { CommandInput } from 'marmeon';
import { environment } from '@marmeon/core';

/**
 * Destructive commands ask for `--force` wherever the app is protected (E139, E164): `production` — a missing `NODE_ENV` too,
 * and whatever `APP_ENV` says (a staging server is `NODE_ENV=production APP_ENV=staging`), like Laravel's confirmation in
 * production. Each names the environment it assumed.
 */
export function confirmed({ options, output }: CommandInput, what: string): boolean {
  output.line(`Environment: ${environment.describe()}`);
  if (!environment.isProtected() || options.force === true) return true;
  output.error(`The application is protected (${environment.describe()}). Pass --force to ${what} — or, on a development machine, set NODE_ENV=development (in .env or the environment).`);
  return false;
}
