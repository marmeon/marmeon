import { isIP } from 'node:net';
import { defineConfig, env, type ConfigOf } from '@marmeon/core';
import type { RelyingParty } from './webauthn.ts';
import { withCode } from '@marmeon/core/internal';

/** Thrown the first time the relying party is needed, when `APP_URL` or the passkey variables cannot name one safely. */
export class PasskeySetupError extends Error {
  override readonly name = 'PasskeySetupError';
}

const LOOPBACK = new Set(['127.0.0.1', '[::1]']);

function problem(message: string): never {
  throw new PasskeySetupError(withCode('A1', `Passkeys cannot be used: ${message}`));
}

/** `http://localhost[:port]`, or `https:` — nothing else is a secure context a browser runs WebAuthn in. */
function checkOrigin(origin: string): URL {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return problem(`"${origin}" is not an origin (expected https://app.example.com or http://localhost:3000).`);
  }
  if (url.origin !== origin) return problem(`"${origin}" is not an origin: write it exactly as ${url.origin} (scheme, host, port; no path, no trailing slash).`);
  if (LOOPBACK.has(url.hostname)) {
    return problem(`"${origin}" is an IP address, which passkeys cannot use. Open the app as http://localhost${url.port ? `:${url.port}` : ''} and set APP_URL to that.`);
  }
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0) return problem(`"${origin}" is an IP address, which passkeys cannot use: they need a domain name (or http://localhost while developing).`);
  if (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) return url;
  return problem(`"${origin}" is not secure: passkeys need https (http works on http://localhost only).`);
}

/**
 * The relying party the app's passkeys belong to, from configuration only — `APP_URL` (the RP ID is its host, the one origin
 * its origin), optionally overridden by `rpId` (`AUTH_PASSKEY_RP_ID`) and a comma-separated `origins` (`AUTH_PASSKEY_ORIGINS`).
 * Never read from a request: a `Host` header is the client's to forge, and a forged relying party accepts responses made for another site.
 * Throws {@link PasskeySetupError}.
 */
export function relyingPartyFrom(input: { appUrl: string | undefined; rpId?: string | undefined; origins?: string | undefined }): RelyingParty {
  if (!input.appUrl) return problem('APP_URL is not set.');
  let app: URL;
  try {
    app = new URL(input.appUrl);
  } catch {
    return problem(`APP_URL "${input.appUrl}" is not a URL.`);
  }
  const listed = input.origins?.split(',').map((origin) => origin.trim()).filter((origin) => origin !== '');
  const origins = listed && listed.length > 0 ? listed : [app.origin];
  const hosts = origins.map((origin) => checkOrigin(origin).hostname);
  const rpId = (input.rpId?.trim() || app.hostname).toLowerCase();
  if (isIP(rpId.replace(/^\[|\]$/g, '')) !== 0) return problem(`the RP ID "${rpId}" is an IP address; it must be a domain name (or localhost).`);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(rpId)) return problem(`the RP ID "${rpId}" is not a bare domain name (no scheme, port or path; write an international name in its punycode form, xn--…).`);
  if (rpId !== 'localhost' && !rpId.includes('.')) return problem(`the RP ID "${rpId}" is a single label, which browsers refuse as a registrable domain.`);
  // A suffix on a label boundary only: the RP ID `example.com` suits app.example.com, `ample.com` does not.
  for (const [index, host] of hosts.entries()) {
    if (host !== rpId && !host.endsWith(`.${rpId}`)) return problem(`the RP ID "${rpId}" is not the host of ${origins[index]} or a parent domain of it.`);
  }
  return { rpId, origins };
}

/**
 * The passkey configuration. Reading it never fails — an app without passkeys boots with any value of these variables; the relying
 * party is checked when {@link PasskeyConfigValue.relyingParty} is first called, and then kept.
 */
export interface PasskeyConfigValue {
  relyingParty(): RelyingParty;
}

export const PasskeyConfig = defineConfig('passkeys', {
  env: env({
    /** The app's URL — the passkey RP ID is its host and the allowed origin its origin. */
    APP_URL: env.string().optional(),
    /** Overrides the RP ID: a parent domain of every origin, e.g. `example.com` when passkeys should work on all its subdomains. */
    AUTH_PASSKEY_RP_ID: env.string().optional(),
    /** Overrides the allowed origins: comma-separated, exact (`https://app.example.com,https://admin.example.com`). */
    AUTH_PASSKEY_ORIGINS: env.string().optional(),
  }),
  resolve: (e): PasskeyConfigValue => {
    let relyingParty: RelyingParty | undefined;
    return {
      relyingParty: () => (relyingParty ??= relyingPartyFrom({ appUrl: e.APP_URL, rpId: e.AUTH_PASSKEY_RP_ID, origins: e.AUTH_PASSKEY_ORIGINS })),
    };
  },
});
export type PasskeyConfig = ConfigOf<typeof PasskeyConfig>;
