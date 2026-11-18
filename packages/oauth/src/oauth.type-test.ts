// Type guarantees of `OAuth.redirect()` and `OAuthHttp.json()` — checked by `tsc` (typecheck), never run.
import type { Result } from '@marmeon/core';
import { expectTypeOf } from 'vitest';
import type { OAuthHttp } from './definition.ts';
import type { OAuth, OAuthRedirectError } from './oauth.ts';

declare const oauth: OAuth;
declare const http: OAuthHttp;

// The options that are allowed.
void oauth.redirect('idp', { intent: 'link', userId: 7, scopes: ['email'], prompt: 'consent' });
void oauth.redirect('idp', { userId: 'u-1', prompt: 'select_account' });

// @ts-expect-error `none` is not a prompt a sign-in may ask for
void oauth.redirect('idp', { prompt: 'none' });
// @ts-expect-error `login` is set by the flow itself, for a confirmation
void oauth.redirect('idp', { prompt: 'login' });
// @ts-expect-error a user id is a string or a number
void oauth.redirect('idp', { userId: {} });
// @ts-expect-error a misspelt key would start an unbound flow
void oauth.redirect('idp', { userid: 7 });

// The Result's error is these three kinds.
expectTypeOf<Awaited<ReturnType<OAuth['redirect']>>>().toEqualTypeOf<Result<URL, OAuthRedirectError>>();
expectTypeOf<OAuthRedirectError['kind']>().toEqualTypeOf<'unknown-provider' | 'unavailable' | 'reauthentication-unsupported'>();

// A form goes with POST; a GET has none.
void http.json('https://x.test/u', { form: { code: 'c' } });
void http.json('https://x.test/u', { method: 'POST', form: { code: 'c' } });
void http.json('https://x.test/u', { method: 'GET', bearer: 't' });
// @ts-expect-error a GET request has no form
void http.json('https://x.test/u', { method: 'GET', form: { code: 'c' } });
