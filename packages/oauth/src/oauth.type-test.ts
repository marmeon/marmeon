// Type guarantees of `OAuth.redirect()` and `OAuthHttp.json()` — checked by `tsc` (typecheck), never run.
import type { Result } from '@marmeon/core';
import { expectTypeOf } from 'vitest';
import type { OAuthHttp, SocialUser } from './definition.ts';
import type { OAuthCallback, OAuthCallbackError } from './callback.ts';
import type { OAuth, OAuthRedirectError, OAuthRedirectOptions } from './oauth.ts';

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

// A confirmation names its user and the account it is for.
void oauth.redirect('idp', { intent: 'confirm', userId: 7, account: 'sub-1' });
// @ts-expect-error a confirmation needs the user
void oauth.redirect('idp', { intent: 'confirm', account: 'sub-1' });
// @ts-expect-error a confirmation needs the account
void oauth.redirect('idp', { intent: 'confirm', userId: 7 });
// @ts-expect-error a user that is undefined is no user
void oauth.redirect('idp', { intent: 'confirm', userId: undefined, account: 'sub-1' });
// @ts-expect-error any other intent has no account
void oauth.redirect('idp', { intent: 'link', userId: 7, account: 'sub-1' });
// A wide intent and no options at all still compile.
declare const intent: string;
void oauth.redirect('idp', { intent });
void oauth.redirect('idp', {});
void oauth.redirect('idp');
declare const opts: OAuthRedirectOptions;
void oauth.redirect('idp', opts);

// The Result's error is these three kinds.
expectTypeOf<Awaited<ReturnType<OAuth['redirect']>>>().toEqualTypeOf<Result<URL, OAuthRedirectError>>();
expectTypeOf<OAuthRedirectError['kind']>().toEqualTypeOf<'unknown-provider' | 'unavailable' | 'reauthentication-unsupported'>();

// The callback takes the query and the signed-in user, and answers a Result.
void oauth.callback('idp', new URLSearchParams(), { userId: 7 });
// @ts-expect-error the query is a URLSearchParams, not its text
void oauth.callback('idp', 'code=1');
// @ts-expect-error a misspelt key would drop the user binding
void oauth.callback('idp', new URLSearchParams(), { userid: 7 });
expectTypeOf<Awaited<ReturnType<OAuth['callback']>>>().toEqualTypeOf<Result<OAuthCallback, OAuthCallbackError>>();

// A form goes with POST; a GET has none.
void http.json('https://x.test/u', { form: { code: 'c' } });
void http.json('https://x.test/u', { method: 'POST', form: { code: 'c' } });
void http.json('https://x.test/u', { method: 'GET', bearer: 't' });
// @ts-expect-error a GET request has no form
void http.json('https://x.test/u', { method: 'GET', form: { code: 'c' } });

// The refusals of a callback are exactly these kinds, and a provider's error carries its code as text.
expectTypeOf<OAuthCallbackError['kind']>().toEqualTypeOf<
  | 'unknown-provider'
  | 'no-flow'
  | 'expired'
  | 'invalid'
  | 'cancelled'
  | 'provider-error'
  | 'unavailable'
  | 'rejected'
  | 'invalid-response'
  | 'not-reauthenticated'
>();
expectTypeOf<Extract<OAuthCallbackError, { kind: 'provider-error' }>['error']>().toEqualTypeOf<string>();
expectTypeOf<OAuthCallback>().toEqualTypeOf<{ readonly user: SocialUser; readonly intent: string }>();
expectTypeOf<SocialUser['tokens']['expiresAt']>().toEqualTypeOf<number | undefined>();
