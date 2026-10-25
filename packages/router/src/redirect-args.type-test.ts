// The arguments of `redirect().route()` for each kind of route entry — checked by `tsc`, never run. Entries are written out
// here: nothing is added to the app's `Routes`.
import type { RedirectArgsOf } from './index.ts';

type Localized = { readonly method: 'get'; readonly path: '/:locale/about'; readonly localized: true };
type LocalizedWithParam = { readonly method: 'get'; readonly path: '/:locale/about/features/:feature'; readonly localized: true };
type OwnLocale = { readonly method: 'get'; readonly path: '/users/:locale' };
type Plain = { readonly method: 'get'; readonly path: '/users/:id' };

// A localized route takes the request's locale: it may be left out, or given.
export const none: RedirectArgsOf<Localized, 'a'> = [];
export const given: RedirectArgsOf<Localized, 'a'> = [{ locale: 'de' }];
export const rest: RedirectArgsOf<LocalizedWithParam, 'a'> = [{ feature: 'x' }];
// @ts-expect-error — the other parameters of a localized route stay required.
export const missing: RedirectArgsOf<LocalizedWithParam, 'a'> = [];
// @ts-expect-error — a localized route has no parameter the path does not name.
export const unknown: RedirectArgsOf<Localized, 'a'> = [{ other: 'x' }];

// A parameter called `locale` of a route that is not localized is an ordinary, required one.
export const own: RedirectArgsOf<OwnLocale, 'a'> = [{ locale: 'de' }];
// @ts-expect-error — only a localized route takes the request's locale.
export const ownMissing: RedirectArgsOf<OwnLocale, 'a'> = [];
export const plain: RedirectArgsOf<Plain, 'a'> = [{ id: 1 }];
// @ts-expect-error — a route's parameters are required.
export const plainMissing: RedirectArgsOf<Plain, 'a'> = [];
