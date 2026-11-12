// The rest of the path as a parameter: a `string` for the controller, optional and `string` only in a URL — checked by `tsc`,
// never run. Entries are written out here: nothing is added to the app's `Routes`.
import { defineRoutes, everyone, type BrowserParamsOf, type ExtractParams } from './index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <_T extends true>(): void => {};

is<Equal<ExtractParams<'/help/:path*'>, { path: string }>>();
is<Equal<ExtractParams<'/:path*'>, { path: string }>>();
is<Equal<ExtractParams<'/:locale/:path*'>, { locale: string } & { path: string }>>();

export default defineRoutes((Route) => {
  Route.authorize(everyone).get('/help/:path*', (ctx) => {
    const path: string = ctx.params.path;
    // @ts-expect-error — `page` is no parameter of the path.
    const wrong = ctx.params.page;
    void [path, wrong];
    return 'x';
  });
});

type Help = { readonly method: 'get'; readonly path: '/help/:path*' };
type Post = { readonly method: 'get'; readonly path: '/blog/:blog/:path*' };

// The rest may be left out or given as a string.
export const none: BrowserParamsOf<'a', Help> = {};
export const given: BrowserParamsOf<'a', Help> = { path: 'a/b' };
export const withOther: BrowserParamsOf<'a', Post> = { blog: 'news', path: 'a' };
export const withoutRest: BrowserParamsOf<'a', Post> = { blog: 'news' };
// @ts-expect-error — a number is no rest of the path.
export const number: BrowserParamsOf<'a', Help> = { path: 7 };
// @ts-expect-error — no such parameter.
export const wrong: BrowserParamsOf<'a', Help> = { page: 'a' };
// @ts-expect-error — the parameters before the rest stay required.
export const missing: BrowserParamsOf<'a', Post> = { path: 'a' };
