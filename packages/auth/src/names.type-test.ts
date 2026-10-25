// What the main entry of @marmeon/auth does not export or accept — compiled by the package build, never run.
import { HashError, PasswordHasher, type HasherOptions } from './index.ts';
// @ts-expect-error — `PasswordHasherInternals` is not exported
import type { PasswordHasherInternals } from './index.ts';

declare const options: HasherOptions;

// @ts-expect-error — the constructor takes only the options: an app cannot declare argon2 unavailable
export const downgraded = new PasswordHasher(options, { isArgon2Available: false });

export type Seams = [HashError, PasswordHasherInternals];
