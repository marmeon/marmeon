# Encryption

## Introduction

`@marmeon/encryption` encrypts and decrypts text with the application key, `APP_KEY`. The framework uses it for every cookie, for
queued jobs that carry secrets, for session data and for the cursors of lists. Your code uses it for anything that leaves the
server and must come back unread and unchanged, such as a value in a link:

```ts title="modules/exports/ExportLinks.ts"
import { Encrypter } from '@marmeon/encryption';

export class ExportLinks {
  readonly #encrypter: Encrypter;

  constructor(encrypter: Encrypter) {
    this.#encrypter = encrypter;
  }

  seal(exportId: number): Promise<string> {
    return this.#encrypter.encrypt(JSON.stringify({ exportId }), 'exports:download');
  }

  async open(payload: string): Promise<{ exportId: number }> {
    return JSON.parse(await this.#encrypter.decrypt(payload, 'exports:download'));
  }
}
```

The encryption is AES-256-GCM, from Node's own `node:crypto`. It is authenticated: without the key, nobody can read a payload, and
nobody can change one without `decrypt()` noticing.

## The application key

`APP_KEY` is `base64:` followed by 32 random bytes in base64, a 256-bit key. A new app gets one when it is created. The command
writes one into `.env`:

```sh
pnpm marmeon key:generate          # writes APP_KEY into .env, copied from .env.example when there is no .env
pnpm marmeon key:generate --show   # prints a new key and writes nothing
pnpm marmeon key:generate --force  # replaces a key that is set, and keeps the old one for rotation
```

The command runs without starting the app, since a missing key is exactly why an app cannot start. It refuses to replace a key
that is set unless you pass `--force`, and its message says what `--force` does: it keeps the old key in `APP_PREVIOUS_KEYS`, so
nothing made with it breaks. `generateKey()` of `@marmeon/encryption` returns a key in the same format, for a test or a
script.

The app checks the key when it starts, with the rest of its configuration. A missing, empty or malformed key stops the start:

```text
• encryption: APP_KEY — Missing — run "marmeon key:generate"
• encryption: APP_KEY — Expected "base64:" followed by 32 base64-encoded bytes — run "marmeon key:generate"
```

A broken entry in `APP_PREVIOUS_KEYS` stops it the same way. `marmeon build` needs no key: the
[configuration](configuration.md#configuration-and-the-build) page explains why.

> [!WARNING]
> Whoever has `APP_KEY` can read every encrypted cookie and job, and forge cookies and signed URLs. Generate a key per
> environment, keep it in the server's secrets, and never commit it or bake it into an image. The `.dockerignore` that
> `marmeon make:docker` writes keeps every `.env` file out of the image.

When the key is missing or broken, the development error page and the output of `marmeon` show a solution, "Generate an
application key", with the command to copy. Nothing runs it for you.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `APP_KEY` | none, required | The key everything is encrypted with: `base64:` and 32 random bytes. Every environment needs one, tests included. |
| `APP_PREVIOUS_KEYS` | empty | Former keys, comma-separated. What they encrypted still decrypts. |

## Encrypting and decrypting

Inject `Encrypter`. It is one object for the whole app.

| Method | What it does |
| --- | --- |
| `encrypt(plaintext, context?)` | Returns the payload, a URL-safe string. |
| `decrypt(payload, context?)` | Returns the text, or throws `DecryptError`. |

- **Text in, text out.** Turn values into text yourself, with `JSON.stringify()`, and parse them after decrypting.
- **Never the same payload twice.** Every call draws a fresh random IV, so encrypting the same text twice gives two payloads. The
  payload holds a version byte, the IV, the ciphertext and a 16-byte authentication tag, in base64url without padding. It fits
  into a cookie or a URL as it is.
- **One error for everything.** A changed byte, another key, another context, garbage or an empty string all end in the same
  `DecryptError`, "The payload is invalid.". It never says which.
- **A context binds a payload to its use.** The second argument is authenticated with the payload, `''` by default. A payload
  encrypted for `exports:download` does not decrypt for another context. Give each use of your own a context of its own, so a
  value from one place cannot be replayed in another.

The framework's own contexts are `cookie:<name>`, `queue:<job name>`, `session:<key>` and `marmeon:cursor:…` for the cursors of
lists. Choose names that do not start with these.

Outside the container, `new AesGcmEncrypter(key, previousKeys)` takes raw 32-byte keys, and `AesGcmEncrypter.fromConfig(config)`
takes the resolved `EncryptionConfig`.

## What the key protects

| What | How |
| --- | --- |
| Every cookie of the `web` group | Encrypted with the context `cookie:<name>`. A changed, foreign or unencrypted value counts as absent. `XSRF-TOKEN` is the one exception, since the browser's JavaScript reads it. |
| Queued jobs | Jobs with `static encrypted = true`, and the framework's own: queued mails, queued listeners and notifications. |
| Session data | In its store, with `SESSION_ENCRYPT=true`. The `cookie` session driver always encrypts. |
| Cursors | The cursors of `cursorPaginate()` and of tables. A changed or made-up cursor answers 400. |
| Signed URLs | Signed with a key derived from `APP_KEY`. |
| Live updates and uploads | The tokens of live channels and of uploads, each signed with a key derived from `APP_KEY`. |
| Tab sync | The session epoch the tabs compare, signed with a key derived from `APP_KEY`. |

Each purpose that signs gets a key of its own, derived from `APP_KEY` with HKDF-SHA-256. A signature is never also a cookie key.

An app whose `web` group has no `Encrypter` does not start: the error says to register `EncryptionServiceProvider` and set
`APP_KEY`. The queue and the live updates check the same when they need it.

## Rotating the key

`encrypt()` always uses `APP_KEY`. `decrypt()` tries `APP_KEY` first and then each key of `APP_PREVIOUS_KEYS` in order. The keys
derived for signatures accept the previous keys too. So a rotation keeps everything valid that the old key made:

1. Run `pnpm marmeon key:generate --force`. It writes a new `APP_KEY` and moves the old one to the front of `APP_PREVIOUS_KEYS`,
   keeping the keys already listed there. Where the environment comes from somewhere else than `.env`, do the same there: the
   current key into `APP_PREVIOUS_KEYS`, a new one from `--show` into `APP_KEY`.
2. Deploy, with both variables on every server.
3. Remove the old key once nothing made with it is still around: sessions and remember-me cookies after their lifetime, queued and
   failed jobs, and signed links after their expiry. Encrypted session data is encrypted with the new key at the session's next
   write. A "load more" cursor made with the old key answers 400 once the key is removed.

One thing follows the new key at once: the tabs of every browser find a new session epoch at their next check and reload once,
because the epoch uses the current key only.

Replacing `APP_KEY` without keeping the old one signs everybody out, because no session cookie decrypts any more. It also breaks
every signed link, and turns every encrypted job still waiting into a failure:
`The encrypted payload of … cannot be decrypted (was APP_KEY changed?)`. The
[deployment](deployment.md#rotating-app_key) page has the short version for a server.

## Testing

Tests need a key like any other environment. A new app keeps a fixed one in `.env.test`. The test client encrypts and decrypts
cookies as the app does: `withCookie(name, value)` sends a value encrypted for that cookie, and `withUnencryptedCookie(name, value)`
sends it as it is, to prove that a forged value is ignored. `response.cookie(name)` and `assertCookie(name, value)` see the
decrypted value. The [HTTP tests](http-tests.md#cookies) page covers cookies in tests.
