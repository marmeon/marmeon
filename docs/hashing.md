# Hashing

## Introduction

A password is never stored, only a hash of it: a value that is cheap to check against a password and expensive to turn back into
one. `Hasher` of `@marmeon/auth` makes and checks such hashes. It uses Argon2id by default, with the costs OWASP recommends, and
computes in Node's thread pool, so a sign-in never blocks other requests.

```ts title="modules/signup/controllers/SignUpController.ts"
import { Hasher, password } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { UserRepository } from '#modules/auth';

export const SignUpRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().min(2).max(255),
    email: r.string().trim().lowercase().required().max(255).email(),
    password: password(),
    password_confirmation: r.string(),
  }).confirmed('password'),
});

export class SignUpController extends Controller {
  static request = SignUpRequest;

  readonly #hasher: Hasher;
  readonly #users: UserRepository;

  constructor(hasher: Hasher, users: UserRepository) {
    super();
    this.#hasher = hasher;
    this.#users = users;
  }

  async handle(ctx: ContextOf<typeof SignUpRequest>) {
    const hash = await this.#hasher.make(ctx.body.password);
    await this.#users.register({ name: ctx.body.name, email: ctx.body.email, password: hash, locale: 'en' });
    return this.redirect().route('auth.register.sent');
  }
}
```

This is a reduced registration, to show the hasher. It sends no confirmation mail, since it dispatches no `Registered`, and a
taken address silently does nothing. Do not put it in place of the starter kit's registration, which does more: it hashes the
password even for a known address, so both take the same time, and keeps quiet about which address has an account. The
[starter kit](starter-kit.md#private-registration) page explains why.

## Making and checking hashes

| Method | What it does |
| --- | --- |
| `make(password)` | A new hash with a fresh salt, by the configured driver and costs. |
| `verify(password, hash)` | Whether the password matches, compared in constant time. A broken or tampered hash is `false`, never an error. |
| `needsRehash(hash)` | Whether the hash was made by another driver or with other costs than the configured ones. |
| `dummyVerify(password)` | Takes as long as a real check, and is always `false`. |
| `failureFloorMs()` | The time a failed sign-in is padded to, in milliseconds (see below). Optional on a custom hasher; without it nothing is padded. |

`dummyVerify()` is for the sign-in of an unknown address: without it, the quick answer would tell a stranger that the address has
no account. `Auth.attempt()` uses it, and rehashes a password whose hash `needsRehash()` by itself after a successful sign-in — only over the hash it verified: when the password was reset meanwhile, the new hash stays and the sign-in fails. A rehash ends no session and no remember-me cookie of the user's other devices: the session keeps no hash, only a fingerprint of the account's id and session key. The provider's `updatePasswordHash()` has to tell whether it wrote (see [`UserProvider`](authentication.md#the-user-type-and-where-users-come-from)).

A broken hash is checked like a good one: `verify()` spends the time of a real check on it, and so does an argon2id hash on a Node
without argon2. After you change the driver or the costs, accounts that still hold an older, slower hash would take longer to
fail than the others. So `Auth.attempt()` waits before it answers a failed sign-in until it has taken as long as
`failureFloorMs()`: the slowest, over every set of hash parameters (driver and costs) this process has verified, of the fastest
check seen for that set. The fastest check is the cost without the queueing of a busy thread pool, and no set is forgotten, so a
burst of cheap failures cannot lower the wait. The first time the process sees another set, it times a hash of that set again in the background, after 75 ms, 1 s, 10 s, 1 min and 10 min, and keeps the lowest, so a sample taken in a busy moment does not stay. The configured costs always count. A success is never delayed, and the wait is a
timer that costs no CPU. What the process cannot know is an old parameter set it has not verified yet, after a restart or on
another node: the first failed sign-in over such a hash can still be told apart. Declaring the previous costs would close that
gap; it is not built yet. Apps may see failed sign-ins take longer than before.

A hash is a string in the PHC format, such as `$argon2id$v=19$m=19456,t=2,p=1$<salt>$<hash>`, with the type `PasswordHash`. The
type keeps the two strings apart: `verify(hash, password)`, with the arguments swapped, does not compile. A hash read from the
database becomes a `PasswordHash` where your `UserProvider` reads it.

## Drivers

| Driver | Costs | Needs |
| --- | --- | --- |
| `argon2id`, the default | 19 MiB of memory, 2 passes, 1 lane | Node 24.7 or newer, built with OpenSSL 3.2 or newer. The official builds are. |
| `scrypt` | N = 2¹⁷, r = 8, p = 1 | Any Node. |

Both come from `node:crypto`. The app makes the hasher when it starts: on a Node without Argon2, the start fails with a message that
names `HASH_DRIVER=scrypt`, not the first sign-in.

`verify()` checks hashes of either driver, whatever is configured. Switching drivers or raising the costs needs no mass reset:
every user's hash is made anew, with the new settings, at their next sign-in, and nobody is signed out by it.

## Limits

- **Bounded costs.** The configuration and every stored hash must stay within the limits below. A hash planted in the database that
  asks for 4 GiB of memory is refused, not computed.
- **At most 4096 bytes.** A longer password is refused, because hashing megabytes per attempt would be a cheap way to burn the
  server's time. `MAX_PASSWORD_BYTES` holds the number.
- **Never trimmed, always normalized.** Spaces belong to the password. The password is normalized to Unicode NFKC first, as NIST
  SP 800-63B asks, so an `é` typed as one character and as `e` with an accent is the same password.
- **Well-formed only.** A string with a lone surrogate cannot be encoded and would collide with others, so `make()` throws a
  `HashError` and `verify()` returns `false`.

## The password rule

`password()` of `@marmeon/auth` is the validation rule for a new password, a rule of `@marmeon/validation`. Its confirmation is the
object's `confirmed('password')`:

```ts title="modules/auth/controllers/ResetPasswordController.ts"
import { password } from '@marmeon/auth';
import { defineRequest } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';

export const ResetPasswordRequest = defineRequest({
  schema: r.object({ password: password({ min: 12 }), password_confirmation: r.string() }).confirmed('password'),
  messages: { 'password_confirmation.confirmed': 'auth.validation.passwords_differ' },
});
```

- **Long enough:** at least `min` characters, 8 by default, counted in code points after NFKC: a plain emoji is one, a flag or an
  emoji with a skin tone is two or more.
- **Short enough:** at most 4096 bytes, the hasher's limit.
- **Nothing else.** No rules about digits or symbols: NIST advises against them, because they make passwords harder to remember
  and no harder to guess.

A missing value says "Enter a password.". The texts are the keys `marmeon.validation.password.*` in English and German;
`password({ messages })` takes your own keys or texts for `required`, `min` and `max`. The [validation](validation.md#objects) page
explains `confirmed()` and its message.

## Where the hash lives

The hash is a secret column of the users table, so `Row<'users'>` and every query that selects all columns leave it out. Only the
`UserProvider` reads it, and hands it next to the user as `Credentials`, never inside it. The session keeps only a fingerprint of
the account, its id and session key, which the [authentication](authentication.md#ending-every-session-of-a-user) page
explains.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `HASH_DRIVER` | `argon2id` | `argon2id` or `scrypt`. |
| `HASH_ARGON_MEMORY` | `19456` | KiB of memory per hash, from 1024 to 262144. |
| `HASH_ARGON_TIME` | `2` | Passes, from 1 to 16. |
| `HASH_ARGON_PARALLELISM` | `1` | Lanes, from 1 to 16. |
| `HASH_SCRYPT_COST` | `17` | The log2 of N, from 10 to 20. |
| `HASH_SCRYPT_BLOCK_SIZE` | `8` | r, from 1 to 32. 128 · N · r must stay within 256 MiB. |
| `HASH_SCRYPT_PARALLELISM` | `1` | p, from 1 to 16. |

A value outside its range stops the start. Raise the costs as far as your server's sign-ins allow, never below the defaults in
production.

## Testing

Hashing at full cost makes tests slow. A new app's `.env.test` sets cheap costs, `HASH_ARGON_MEMORY=1024` and `HASH_ARGON_TIME=1`:
tests check behaviour, not strength. `UserFactory` stores one hash made at these costs for every user, with the password
`password`, so making fifty users hashes nothing.
