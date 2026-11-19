import type { Session } from '@marmeon/session';
import type { FakeSession, Parts } from './flow.ts';
import { oauthWith } from './flow.ts';
import { flowKey, type OpenFlow } from '../flow.ts';
import type { OAuthRedirectOptions } from '../oauth.ts';

export const TOKEN_URL = 'https://id.example.com/token';

/** A token response of the shape RFC 6749 gives; `extra` adds or replaces fields. */
export const tokenResponse = (extra: Record<string, unknown> = {}): Response => Response.json({ access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600, ...extra });

/** An `OAuth` with a flow already started at `idp` (the token endpoint answers a good token response) and the query the provider would send back. */
export async function started<S extends Session = FakeSession>(parts: Parts<S> = {}, options: OAuthRedirectOptions = {}) {
  const made = oauthWith(parts);
  made.http.respond(TOKEN_URL, () => tokenResponse());
  const redirect = await made.oauth.redirect('idp', options);
  if (!redirect.ok) throw new Error('expected a flow');
  const held = made.session as unknown as FakeSession;
  // A fake session keeps what it holds in `data`; a real one answers `get`.
  const flow = (held.data === undefined ? (held.get(flowKey('idp') as never) as unknown) : held.data.get(flowKey('idp'))) as OpenFlow;
  /** The query of a good callback, with `extra` added (a value `undefined` removes the parameter). */
  const query = (extra: Record<string, string | undefined> = {}): URLSearchParams => {
    const params = new URLSearchParams({ code: 'the-code', state: flow.state });
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined) params.delete(key);
      else params.set(key, value);
    }
    return params;
  };
  return { ...made, flow, query };
}
