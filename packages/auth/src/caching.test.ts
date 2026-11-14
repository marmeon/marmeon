import type { HttpContext } from '@marmeon/router';
import type { Session } from '@marmeon/session';
import { guardUserKey, isSessionIdentityKey } from '@marmeon/session/internal';
import { describe, expect, it } from 'vitest';
import { AUTH_SESSION_KEYS } from './auth.ts';
import { NO_STORE, NoStoreWhenSignedIn } from './caching.ts';

const session = (data: Record<string, unknown>, started = true) =>
  ({ started, get: (key: string) => data[key], identityKeys: () => Object.keys(data).filter(isSessionIdentityKey) }) as unknown as Session;
const handle = (s: Session, response: Response) => new NoStoreWhenSignedIn(s).handle({} as HttpContext, async () => response);

describe('NoStoreWhenSignedIn', () => {
  it('marks answers for a signed-in session no-store, private — redirects with immutable headers too', async () => {
    const signedIn = session({ [AUTH_SESSION_KEYS.id]: 1 });
    expect((await handle(signedIn, new Response('page'))).headers.get('cache-control')).toBe(NO_STORE);
    expect((await handle(signedIn, Response.redirect('http://app.test/', 302))).headers.get('cache-control')).toBe(NO_STORE);
  });

  it('marks answers for a session signed in to a package guard only, whatever the app guard did', async () => {
    const office = session({ [guardUserKey('office')]: 1 });
    expect((await handle(office, new Response('page'))).headers.get('cache-control')).toBe(NO_STORE);
    // Other bookkeeping keys of a guard are no sign-in.
    expect((await handle(session({ '_auth:office:password': 'x', '_auth:office:pending': {} }), new Response('page'))).headers.get('cache-control')).toBeNull();
  });

  it('leaves guests, sessionless requests and a route’s own Cache-Control alone', async () => {
    expect((await handle(session({}), new Response('page'))).headers.get('cache-control')).toBeNull();
    expect((await handle(session({}, false), new Response('page'))).headers.get('cache-control')).toBeNull();
    const own = new Response('report', { headers: { 'cache-control': 'private, max-age=60' } });
    expect((await handle(session({ [AUTH_SESSION_KEYS.id]: 1 }), own)).headers.get('cache-control')).toBe('private, max-age=60');
  });
});
