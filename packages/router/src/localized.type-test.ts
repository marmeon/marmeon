import { defineRoutes } from './index.ts';

// The locale is a path parameter of every route of a localized registrar, next to the ones the path names.
defineRoutes((Route) => {
  Route.localized().get('/about/:topic', (ctx) => {
    const locale: string = ctx.params.locale;
    const topic: string = ctx.params.topic;
    // @ts-expect-error — only the parameters of the path exist.
    ctx.params.nothing;
    return [locale, topic];
  });
  Route.localized()
    .prefix('/docs')
    .get('/', (ctx) => ctx.params.locale);
  // A route outside localized() has no locale.
  Route.get('/plain', (ctx) =>
    // @ts-expect-error — no `locale` here.
    ctx.params.locale,
  );
});
