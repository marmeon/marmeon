// The parameters of a route in the browser — checked by `tsc`, never run. Entries are written out here: nothing is added to the
// app's `Routes`.
import type { BrowserParamsOf } from './index.ts';

type Localized = { readonly method: 'get'; readonly path: '/:locale/about'; readonly localized: true };
type LocalizedWithParam = { readonly method: 'get'; readonly path: '/:locale/about/:feature'; readonly localized: true };
type OwnLocale = { readonly method: 'get'; readonly path: '/users/:locale' };

// The locale of a localized route may be left out, or given.
export const none: BrowserParamsOf<'a', Localized> = {};
export const given: BrowserParamsOf<'a', Localized> = { locale: 'de' };
export const rest: BrowserParamsOf<'a', LocalizedWithParam> = { feature: 'x' };
// @ts-expect-error — the other parameters stay required.
export const missing: BrowserParamsOf<'a', LocalizedWithParam> = {};
// @ts-expect-error — a parameter the path lacks.
export const unknown: BrowserParamsOf<'a', Localized> = { other: 'x' };
// A route that is not localized keeps the `locale` of its own path required.
// @ts-expect-error — nothing says what this `locale` is.
export const own: BrowserParamsOf<'a', OwnLocale> = {};
