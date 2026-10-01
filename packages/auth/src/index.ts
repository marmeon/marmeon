import { defineConfig, type Application, type ConfigOf, type Container, type ServiceProvider } from '@bespokecore/core';
import * as v from 'valibot';
import { Auth } from './auth.ts';
import { DEFAULT_HASHER_OPTIONS, HASH_LIMITS, Hasher, PasswordHasher } from './hashing.ts';
import { UserProvider } from './user.ts';

// Authentication (Wave 4): hashing, the session guard, middleware; policies and tokens follow.
export { Auth, AUTH_SESSION_KEYS, passwordFingerprint } from './auth.ts';
export { Failed, Lockout, Login, Logout } from './events.ts';
export { authenticate, guest } from './middleware.ts';
export type { AuthenticateOptions } from './middleware.ts';
export { authenticatedSession } from './testing.ts';
export { UserProvider } from './user.ts';
export type { AuthTypes, AuthTypesNotDeclared, AuthUser, AuthUserId, Authenticated, Credentials, UserOf } from './user.ts';
export {
  argon2Available,
  DEFAULT_HASHER_OPTIONS,
  HASH_LIMITS,
  HashError,
  Hasher,
  MAX_PASSWORD_BYTES,
  PasswordHasher,
} from './hashing.ts';
export type { Argon2Options, HashDriver, HasherOptions, PasswordHash, ScryptOptions } from './hashing.ts';

const whole = (fallback: number, [min, max]: readonly [number, number]) =>
  v.optional(v.pipe(v.string(), v.transform(Number), v.integer(), v.minValue(min), v.maxValue(max)), String(fallback));

export const HashConfig = defineConfig('hash', {
  env: v.object({
    /** `argon2id` (default, OWASP's first choice) or `scrypt` (where Node lacks argon2). Hashes of both are verified either way. */
    HASH_DRIVER: v.optional(v.picklist(['argon2id', 'scrypt']), DEFAULT_HASHER_OPTIONS.driver),
    /** argon2id: KiB of memory per hash (OWASP: 19456). Tests set it low in `.env.test`. */
    HASH_ARGON_MEMORY: whole(DEFAULT_HASHER_OPTIONS.argon2.memory, HASH_LIMITS.argon2.memory),
    HASH_ARGON_TIME: whole(DEFAULT_HASHER_OPTIONS.argon2.time, HASH_LIMITS.argon2.time),
    HASH_ARGON_PARALLELISM: whole(DEFAULT_HASHER_OPTIONS.argon2.parallelism, HASH_LIMITS.argon2.parallelism),
    /** scrypt: log2 of N (OWASP: 17). */
    HASH_SCRYPT_COST: whole(DEFAULT_HASHER_OPTIONS.scrypt.cost, HASH_LIMITS.scrypt.cost),
    HASH_SCRYPT_BLOCK_SIZE: whole(DEFAULT_HASHER_OPTIONS.scrypt.blockSize, HASH_LIMITS.scrypt.blockSize),
    HASH_SCRYPT_PARALLELISM: whole(DEFAULT_HASHER_OPTIONS.scrypt.parallelism, HASH_LIMITS.scrypt.parallelism),
  }),
  resolve: (env) => ({
    driver: env.HASH_DRIVER,
    argon2: { memory: env.HASH_ARGON_MEMORY, time: env.HASH_ARGON_TIME, parallelism: env.HASH_ARGON_PARALLELISM },
    scrypt: { cost: env.HASH_SCRYPT_COST, blockSize: env.HASH_SCRYPT_BLOCK_SIZE, parallelism: env.HASH_SCRYPT_PARALLELISM },
  }),
});
export type HashConfig = ConfigOf<typeof HashConfig>;

/** Registers the `Hasher` (`HASH_DRIVER`) and `Auth` (per request). Found by `bespoke discover`. */
export class AuthServiceProvider implements ServiceProvider {
  static config = [HashConfig];

  register(container: Container): void {
    // Built now, not on first use: a Node without argon2 stops the boot with the fix, not the first login.
    container.instance(Hasher, new PasswordHasher(container.make(HashConfig)));
    container.scoped(Auth);
  }

  boot(app: Application): void {
    if (app.modules.length > 0 && !app.container.has(UserProvider)) {
      throw new Error(
        'Authentication needs to know where users come from: bind a UserProvider in a provider of your auth module — ' +
          'container.bind(UserProvider, UserRepository) — and declare the user type: ' +
          "declare module '@bespokecore/auth' { interface AuthTypes { user: User } }.",
      );
    }
  }
}
