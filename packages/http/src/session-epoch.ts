import { createHmac, hkdfSync } from 'node:crypto';
import { Translator, type Container, type Key, type Resolver } from '@bespokecore/core';
import { EncryptionConfig } from '@bespokecore/encryption';
import { PageSession } from './page-session.ts';

/**
 * The session's epoch (W8 step 8, E148/E165): what the tabs of one browser compare to know that someone signed in or out, the
 * session was regenerated or the language changed — `PageObject.epoch`, the answer of `/_bespoke/session`. An HMAC (its key
 * derived from `APP_KEY` by HKDF, context `session-epoch`) over the session's generation and user (`PageSession.generation()`)
 * and the locale, truncated: opaque — it tells nothing about the session, the user or the language, and cannot be guessed
 * without the key. Equal input, equal epoch: flash messages and other session writes leave it as it is.
 */
export class SessionEpoch {
  readonly #key: Uint8Array;
  /** The epochs computed lately — a session asks for the same one on every page (an HMAC is ≈ 1.4 µs, a lookup ≈ 0.1). */
  readonly #recent = new Map<string, string>();

  constructor(config: EncryptionConfig) {
    this.#key = new Uint8Array(hkdfSync('sha256', config.key, new Uint8Array(0), 'bespokecore:session-epoch', 32));
  }

  /** The epoch of a session's generation (undefined: a guest) in `locale`. */
  of(generation: string | undefined, locale: string | undefined): string {
    const input = `${generation ?? ''}\n${locale ?? ''}`;
    let epoch = this.#recent.get(input);
    if (epoch === undefined) {
      epoch = createHmac('sha256', this.#key).update(input).digest('base64url').slice(0, 22);
      if (this.#recent.size >= RECENT_EPOCHS) this.#recent.clear();
      this.#recent.set(input, epoch);
    }
    return epoch;
  }
}

/** How many epochs {@link SessionEpoch} keeps at most (then it starts over) — opaque strings, about 100 bytes each. */
const RECENT_EPOCHS = 1024;

/**
 * The epoch of the request `scope` belongs to — undefined without a `SessionEpoch` (a kernel without the http provider). Without a
 * session (`PageSession`) or a translator, their part is empty.
 */
export function epochOf(scope: Pick<Container, 'has' | 'make'> | undefined): string | undefined {
  if (!scope?.has(SessionEpoch)) return undefined;
  const generation = scope.has(PageSession) ? scope.make(PageSession).generation() : undefined;
  const locale = scope.has(Translator) ? scope.make(Translator).locale : undefined;
  return scope.make(SessionEpoch).of(generation, locale);
}

/** {@link epochOf} for a binding's resolver (which cannot say what is bound): a service that is not there counts as none. */
export function epochOfResolver(resolver: Resolver): string {
  const optional = <T>(key: Key<T>): T | undefined => {
    try {
      return resolver.make(key);
    } catch {
      return undefined; // no session (or no translator) in this app
    }
  };
  return resolver.make(SessionEpoch).of(optional(PageSession)?.generation(), optional(Translator)?.locale);
}

/**
 * `GET /_bespoke/session` (`SESSION_PATH`): the current epoch, as `{ "epoch": "…" }` — what a tab asks when it becomes visible
 * again, comes back from the back/forward cache or hears another epoch on the channel. Read-only (the kernel): it starts no
 * session, writes none and extends none, and sets no cookie; `no-store`, never cached.
 */
export class SessionEpochController {
  readonly #epoch: () => string;

  constructor(epoch: () => string) {
    this.#epoch = epoch;
  }

  handle(): Response {
    return Response.json({ epoch: this.#epoch() }, { headers: { 'cache-control': 'no-store' } });
  }
}
