import { serve, type ServerType } from '@hono/node-server';
import type { Router } from '@bespokecore/router';
import { Hono } from 'hono';
import { renderResponse } from './render.ts';

/**
 * The HTTP kernel: Hono does the URL matching, the BespokeCore router runs the
 * typed middleware pipeline and the action.
 */
export function createHttpKernel(router: Router): Hono {
  const app = new Hono();

  for (const route of router.routes) {
    app.on([...route.methods], route.path, (c) =>
      router.dispatch(route, { request: c.req.raw, params: c.req.param() }, renderResponse),
    );
  }

  return app;
}

export interface ServeOptions {
  router: Router;
  port?: number;
}

export function startServer({ router, port = 3000 }: ServeOptions): ServerType {
  const app = createHttpKernel(router);
  return serve({ fetch: app.fetch, port }, (info) => {
    console.log(`BespokeCore listening on http://localhost:${info.port} (${router.routes.length} routes)`);
  });
}
