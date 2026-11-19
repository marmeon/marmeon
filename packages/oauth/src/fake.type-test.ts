// Type guarantees of `fakeOAuth()` — checked by `tsc` (typecheck), never run.
import type { Container } from '@marmeon/core';
import type { HttpClientFake } from '@marmeon/fetch/testing';
import { expectTypeOf } from 'vitest';
import { fakeOAuth, type OAuthFake } from './fake.ts';

declare const app: { readonly container: Container; readonly http: HttpClientFake };
declare const fake: OAuthFake;

expectTypeOf(fakeOAuth(app, { only: ['github'] })).toEqualTypeOf<OAuthFake>();
expectTypeOf(fake.callbackUrl('https://oauth.fake.invalid/github/authorize?state=a')).toBeString();
expectTypeOf(fake.callbackUrl(new URL('https://oauth.fake.invalid/github/authorize'), { state: 'forged' })).toBeString();
expectTypeOf(fake.authorizations).toEqualTypeOf<readonly URLSearchParams[]>();

// The id is the one thing a profile needs.
void fake.user('github', { id: '42', email: 'ada@example.com', emailVerified: true, claims: { hd: 'example.org' } });
// @ts-expect-error a profile without an id vouches for nobody
void fake.user('github', { email: 'ada@example.com' });
// @ts-expect-error an id is a string
void fake.user('github', { id: 42 });
// @ts-expect-error a misspelt option would make every provider active
void fakeOAuth(app, { onlyy: ['github'] });
// @ts-expect-error the fake takes the test app, not the container alone
void fakeOAuth({ container: app.container });
// @ts-expect-error the seconds ago are a number
void fake.staleAuthentication('microsoft', '60');
