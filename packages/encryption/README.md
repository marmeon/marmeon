# @bespokecore/encryption

Symmetric, authenticated encryption with the application key — Laravel's `Encrypter`: AES-256-GCM, keyed by `APP_KEY`, with
previous keys for rotation. `@bespokecore/http` encrypts every cookie with it, `@bespokecore/queue` encrypted job payloads,
`@bespokecore/session` the session data with `SESSION_ENCRYPT=true`, `@bespokecore/database` the cursors of `cursorPaginate`; the
key itself (`EncryptionConfig`) is what signed URLs, live tokens, upload tokens and the tabs' session epoch derive keys of their
own from.

```ts
import { Encrypter } from '@bespokecore/encryption';

// constructor(encrypter: Encrypter) — a singleton
const payload = await this.#encrypter.encrypt(JSON.stringify({ exportId: 7 }), 'exports:download');
const data = JSON.parse(await this.#encrypter.decrypt(payload, 'exports:download'));   // DecryptError when anything is off
```

It comes with `@bespokecore/http` (a dependency of it, of `@bespokecore/session`, `@bespokecore/live`, `@bespokecore/cli` and
`@bespokecore/testing`); `bespoke discover` registers its `EncryptionServiceProvider` through the `"bespoke"` field of its
package.json. The queue and storage take it as an optional peer: only an encrypted job or uploads need it.

## The key: `APP_KEY`

`base64:` followed by 32 random bytes, base64-encoded — a 256-bit AES key.

```sh
bespoke key:generate          # writes APP_KEY=base64:… into .env (copied from .env.example first when there is no .env)
bespoke key:generate --show   # prints a new key, writes nothing
bespoke key:generate --force  # replaces a key that is set — the old one moves to APP_PREVIOUS_KEYS ("Key rotation")
```

`key:generate` runs without booting the app (a missing key is exactly why it cannot boot), and refuses to replace a key that is
set: `APP_KEY is already set. Replacing it makes existing sessions and encrypted cookies unreadable — use --force.` In code,
`generateKey()` returns a key in the same format.

## Configuration

```sh
APP_KEY=base64:…                      # required — every environment, tests included (not by `bespoke build`, below)
APP_PREVIOUS_KEYS=base64:…,base64:…   # optional, comma-separated: former keys that still decrypt
```

`EncryptionConfig` (`config.key`, `config.previousKeys` — the decoded bytes) is checked at the start with every other config
([configuration](../core/README.md#configuration)): a missing, empty or malformed key stops it with one `ConfigError`, e.g.

```text
• encryption: APP_KEY — Missing — run "bespoke key:generate"
• encryption: APP_KEY — Expected "base64:" followed by 32 base64-encoded bytes — run "bespoke key:generate"
```

A broken entry in `APP_PREVIOUS_KEYS` fails the same way. `bespoke build` needs neither (E187): its build phase registers the
providers without booting them and leaves a configuration that does not validate out — the `Encrypter` is only made when
something resolves it, and reading `EncryptionConfig` then throws a `ConfigError` that names `APP_KEY`
([the build phase](../core/README.md#modules-definemodule)).

## The `Encrypter`

- **AES-256-GCM through `node:crypto`** (`AesGcmEncrypter`). The payload is `base64url(version · iv · ciphertext + tag)` without
  padding — a version byte (`1`), a random 12-byte IV, the ciphertext and its 16-byte authentication tag. Cookie- and URL-safe;
  the same plaintext never gives the same payload twice. The keys are imported once, when the encrypter is made.
- **Fast enough for every request:** a session-sized payload (250 bytes) takes ≈ 3.9 µs to encrypt and ≈ 2.8 µs to decrypt. Until
  Wave 8 step 9 the encrypter used WebCrypto — the same layout, but ≈ 18.5 and ≈ 17.5 µs (each call a job on WebCrypto's queue and
  a promise); a page with a session decrypts one cookie and encrypts two. Payloads written by either decrypt with the other
  (a test encrypts and decrypts across both, with the current and the previous keys); the tag must be the full 16 bytes.
- **Authenticated:** a payload cannot be read or changed without the key. Tampered bytes, another key, garbage or an empty
  string all end in the same `DecryptError` (`The payload is invalid.`) — it never says which.
- **`context` binds a payload to its use** (additional authenticated data, default `''`): a value encrypted for the cookie
  `session` does not decrypt as the cookie `remember`. The framework's contexts are `cookie:<name>`, `queue:<job name>`, `session:<key>` and
  `bespoke:cursor:<direction>:<columns>`;
  pick your own for your own payloads (`exports:download`).
- **Strings in, strings out:** serialize yourself (`JSON.stringify`) — there is no implicit serialization like Laravel's.
- **Outside the container:** `new AesGcmEncrypter(key, previousKeys)` takes raw 32-byte keys (anything else is a `TypeError`),
  `AesGcmEncrypter.fromConfig(config)` an `EncryptionConfig`.

## Key rotation

`encrypt()` always uses `APP_KEY`; `decrypt()` tries `APP_KEY`, then each of `APP_PREVIOUS_KEYS` in order. The keys derived from
`APP_KEY` (below) accept the previous keys too — signed links, live tokens and upload tokens survive a rotation. The session
epoch is computed with the current key only: after a deploy with a new key every open tab finds a new epoch at its next check
and reloads once ([tab sync](../http/README.md#tab-sync-w8-step-8)).

1. `bespoke key:generate --force` writes a new `APP_KEY` into `.env` and moves the old one to the front of `APP_PREVIOUS_KEYS`
   (E169: `The old key moved to APP_PREVIOUS_KEYS: sessions, encrypted cookies and signed links stay valid. Set both on every
   server.`) — keys already listed there stay behind it, without duplicates. Where the
   environment comes from elsewhere, do the same there: the current key into `APP_PREVIOUS_KEYS`, a new one (`--show`) into `APP_KEY`.
2. Deploy, with both variables on every server.
3. Remove the old key once nothing encrypted or signed with it is still around: sessions and remember-me cookies (their
   lifetime; encrypted session data, `SESSION_ENCRYPT`, is re-encrypted with the new key at the session's next write), queued and
   failed jobs, signed links (their expiry). A "load more" cursor made with the old key answers 400 from then on.

Replacing `APP_KEY` **without** keeping the old one signs everybody out (the session cookie no longer decrypts — it counts as
absent), invalidates every signed link and turns encrypted jobs still waiting into poison (failed at once:
`The encrypted payload of … cannot be decrypted (was APP_KEY changed?)`).

## Who uses it

| Package | What | Key |
|---|---|---|
| [@bespokecore/http](../http/README.md) | `EncryptCookies` in the `web` group: every cookie the app sets and reads | the `Encrypter`, context `cookie:<name>` |
| [@bespokecore/queue](../queue/README.md#secrets-in-payloads-e105) | jobs with `static encrypted = true`, the framework's own jobs | the `Encrypter`, context `queue:<job name>` |
| [@bespokecore/session](../session/README.md#hashed-keys-versions-and-encryption-e144-e145) | the session data in its store with `SESSION_ENCRYPT=true` (off by default) | the `Encrypter`, context `session:<key>` (the session's store key) |
| [@bespokecore/database](../database/README.md#pagination) | `cursorPaginate`'s `nextCursor` (W9: the last row's values — hidden sort columns too — neither readable nor made up; one that does not decrypt is a 400) | the `Encrypter` (its `encrypter` option), context `bespoke:cursor:<direction>:<columns>` |
| [@bespokecore/http](../http/README.md) | `UrlSigner` — signed URLs, HMAC-SHA-256 | HKDF-SHA-256 of each key, info `bespokecore:signed-url` |
| [@bespokecore/live](../live/README.md#the-guarantees) | the tokens of the channels a page follows | HKDF-SHA-256, info `bespokecore:live` |
| [@bespokecore/storage](../storage/README.md#uploads) | upload tokens | HKDF-SHA-256, info `bespokecore:upload-token` |
| [@bespokecore/http](../http/README.md#tab-sync-w8-step-8) | the session epoch (`PageObject.epoch`, E148/E165), HMAC-SHA-256 | HKDF-SHA-256 of `APP_KEY` only, info `bespokecore:session-epoch` |

- **Cookies:** the session id, the `cookie` session driver's data and auth's remember-me cookie are encrypted this way — every
  cookie except the names given to `CookieEncryption.except()` (the session package excepts `XSRF-TOKEN`: the browser's
  JavaScript reads it). A tampered, foreign or plain value counts as absent.
- **Jobs:** the framework's own jobs are always encrypted — `bespoke.mail`, `bespoke.listener`, `bespoke.notification`.
- **Derived keys:** each purpose gets a key of its own — a signature is never also a cookie key.
- **Checked at the start**, not on the first request: `@bespokecore/http` fails when the `web` group has no `Encrypter` (`The web
  middleware group needs the Encrypter — register EncryptionServiceProvider from @bespokecore/encryption (discovery does this
  automatically) and set APP_KEY.`), the queue when an encrypted job or a queued listener exists without it, live when it builds
  its tokens.

## The solution on the error page (E130)

The provider brings a [solution](../core/README.md#solutions-e130) for every error whose message names `APP_KEY` — a missing or
broken key at the start, or a package that needs one: **Generate an application key**, with the command
`bespoke key:generate` to copy and the warning about rotation above. `bespoke` prints it below the error when the app cannot
start; the development error page shows it. Text only — nothing runs it for you.

## Testing

Tests need a key like any other environment: the web app keeps a fixed one in `.env.test`; a test that boots an app of its own
passes one (`createApplication({ env: { APP_KEY: generateKey() }, providers: [EncryptionServiceProvider] })`).
[@bespokecore/testing](../testing/README.md) encrypts and decrypts cookies like the app: `app.withCookie(name, value)` sends a value encrypted for
that cookie, `withUnencryptedCookie(name, value)` sends it as given (to prove forged values are ignored), and
`response.cookie(name)` / `assertCookie(name, value)` see the decrypted value.
