import { withCode } from '@marmeon/core/internal';
import { OAuthSetupError } from './config.ts';
import type { OAuthEndpoints, OAuthHttp } from './definition.ts';
import { checkEndpoint, checkEndpoints, EndpointError } from './endpoints.ts';
import { OAuthHttpError } from './http.ts';

/** What a discovery finds: the endpoints of the flow, and the address of the userinfo endpoint when it was asked for. */
export interface Discovered {
  readonly endpoints: OAuthEndpoints;
  readonly userinfoUrl: string | undefined;
}

/** What a discovery is made of. */
export interface DiscoveryOptions {
  /** The address of the discovery document. */
  readonly url: string;
  /** The issuer the document must name, as exact text. */
  readonly issuer: string;
  /** Whether the document must name a usable `userinfo_endpoint`. */
  readonly userinfo: boolean;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** Whether plain http to a loopback host is accepted (development and test). */
  readonly local: boolean;
}

const MAX_BYTES = 256 * 1024;
const FOUND_FOR = 60 * 60 * 1000;
const FAILED_FOR = 10 * 1000;
const SHOWN = 200;

/** A value from a document as text for a message, cut short: it is the other side's text. */
const shown = (value: unknown): string => (typeof value === 'string' ? JSON.stringify(value.slice(0, SHOWN)) : `a value of type ${typeof value}`);

/**
 * Finds the endpoints in the discovery document of an OpenID Connect provider. The result is kept for an hour, a failure for ten
 * seconds (so a provider that is down does not cost a request for every sign-in), and calls that come while a request is running share
 * it. The addresses are checked here (a document without usable ones is an `OAuthHttpError`, so it counts as a failure and is kept
 * for ten seconds only). Throws {@link OAuthSetupError} (A10) when the document names another issuer
 * than the one asked for (the address is then a provider that is not the one configured).
 */
export function createDiscovery(options: DiscoveryOptions): (http: OAuthHttp) => Promise<Discovered> {
  let cached: { readonly promise: Promise<Discovered>; expires: number } | undefined;

  const fetchDocument = async (http: OAuthHttp): Promise<Discovered> => {
    const document = await http.json(options.url, { maxBytes: MAX_BYTES });
    if (typeof document !== 'object' || document === null || Array.isArray(document)) throw new OAuthHttpError(0);
    const { issuer, authorization_endpoint: authorizeUrl, token_endpoint: tokenUrl, userinfo_endpoint: userinfo } = document as Record<string, unknown>;
    // An issuer that differs by one character is another provider: its endpoints would receive the code and the secret.
    if (issuer !== options.issuer) {
      throw new OAuthSetupError(withCode('A10', `The discovery document at ${options.url} names the issuer ${shown(issuer)}, but the issuer is ${JSON.stringify(options.issuer)}. They must be the same text, character for character.`));
    }
    // A document that does not give usable endpoints is the provider's state, like no document: dropped here, so that it is kept for
    // ten seconds and not for an hour. The fixed reason of the check stays in the cause, for the log.
    const usable = <T>(check: () => T): T => {
      try {
        return check();
      } catch (error) {
        if (error instanceof EndpointError) throw new OAuthHttpError(0, { cause: error });
        throw error;
      }
    };
    const endpoints = usable(() => checkEndpoints({ authorizeUrl, tokenUrl, issuer }, 'The discovery document', 'A10', options.local));
    const userinfoUrl = options.userinfo ? usable(() => checkEndpoint(userinfo, 'The userinfo_endpoint of the discovery document', 'A10', options.local).href) : undefined;
    return { endpoints, userinfoUrl };
  };

  return (http) => {
    const now = options.now();
    if (cached !== undefined && now < cached.expires) return cached.promise;
    const entry = { promise: fetchDocument(http), expires: now + FOUND_FOR };
    cached = entry;
    entry.promise.catch(() => {
      entry.expires = options.now() + FAILED_FOR;
    });
    return entry.promise;
  };
}
