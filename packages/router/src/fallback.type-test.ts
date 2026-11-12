// What a fallback's controller sees, and what it cannot be: checked by `tsc`, never run.
import * as v from 'valibot';
import { defineRequest, defineRoutes, everyone, type ContextOf } from './index.ts';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const is = <_T extends true>(): void => {};

const WithBody = defineRequest({ schema: v.object({ name: v.string() }) });
class BodyController {
  static request = WithBody;
  handle(ctx: ContextOf<typeof WithBody>) {
    return ctx.body.name;
  }
}

const WithQuery = defineRequest({ query: v.object({ page: v.optional(v.string(), '1') }) });
class QueryController {
  static request = WithQuery;
  handle(ctx: ContextOf<typeof WithQuery>) {
    return ctx.query.page;
  }
}

export default defineRoutes((Route) => {
  const page = Route.authorize(everyone);
  // The rest of the path is a string, and nothing else is a parameter.
  page.prefix('/help').fallback((ctx) => {
    is<Equal<typeof ctx.params.path, string>>();
    // @ts-expect-error — `page` is no parameter of a fallback.
    const wrong = ctx.params.page;
    void wrong;
    return 'x';
  });
  // A fallback may validate the URL.
  page.prefix('/blog').fallback(QueryController);
  // @ts-expect-error — a fallback answers GET, which has no body: validate the URL with `query`.
  page.prefix('/news').fallback(BodyController);
  // Under a locale the controller also gets the locale: a string, the rest of the path stays one.
  page.localized().prefix('/docs').fallback((ctx) => {
    is<Equal<typeof ctx.params.locale, string>>();
    is<Equal<typeof ctx.params.path, string>>();
    // @ts-expect-error — nothing else is a parameter of a localized fallback.
    const wrong = ctx.params.page;
    void wrong;
    return 'x';
  });
  // @ts-expect-error — a localized fallback answers GET too: validate the URL with `query`.
  page.localized().prefix('/guides').fallback(BodyController);
});
