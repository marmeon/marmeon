import { ConsoleLogger, createApplication, defineModule, Logger, type Container } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider, island, view, type HttpContext, type RegionResult } from '@marmeon/http';
import { PageSession } from '@marmeon/http/internal';
import type { Next } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { FALLBACK_TEMPLATE } from './html.ts';
import { createHttpKernel } from './kernel.ts';
import { ServerServiceProvider } from './provider.ts';
import { createDocumentRenderer } from './render.ts';
import { openRoutes } from './test-helpers/open-routes.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';
import type { SsrRender } from '@marmeon/http';

const ISLAND = { [PAGE_HEADER]: PROTOCOL_VERSION, 'x-marmeon-region': 'island' };

/** What the kernel logged, at any level. */
const logged: string[] = [];
class RecordingLogger extends ConsoleLogger {
  override error(message: string): void {
    logged.push(message);
  }
  override warn(message: string): void {
    logged.push(message);
  }
  override child(): Logger {
    return this;
  }
}
class LoggingProvider {
  register(container: Container) {
    container.singleton(Logger, () => new RecordingLogger());
  }
}

const SESSION_MIDDLEWARE = Symbol.for('marmeon.middleware.session');

/** A middleware class that starts the session, as `StartSession` marks itself. */
class StartsSession {
  static readonly [SESSION_MIDDLEWARE] = true;
  handle(_ctx: HttpContext, next: Next<{}>) {
    return next();
  }
}

describe('an island request to a route that is no island', async () => {
  /** What ran: each middleware layer and the controllers. */
  const ran = { global: 0, group: 0, route: 0, controller: 0 };
  const total = () => ran.global + ran.group + ran.route + ran.controller;
  class GlobalCount {
    handle(_ctx: HttpContext, next: Next<{}>) {
      ran.global++;
      return next();
    }
  }
  class GroupCount {
    handle(_ctx: HttpContext, next: Next<{}>) {
      ran.group++;
      return next();
    }
  }
  class RouteCount {
    handle(_ctx: HttpContext, next: Next<{}>) {
      ran.route++;
      return next();
    }
  }
  class PageController {
    handle() {
      ran.controller++;
      return view('pages/Show', {});
    }
  }
  class RealIsland {
    handle() {
      ran.controller++;
      return island('islands/Real', { ok: true });
    }
  }
  const routes = openRoutes((Route) => {
    const counted = Route.middleware(RouteCount);
    counted.get('/page', PageController);
    counted.get('/json', () => {
      ran.controller++;
      return Response.json({ secret: 'users' });
    });
    counted.get('/closure', () => {
      ran.controller++;
      return island('islands/Closure', {});
    });
    counted.get('/island', RealIsland);
    Route.get('/about', PageController).sitemap();
    Route.middleware(StartsSession).get('/sessioned', PageController);
    Route.get('/embeds-session', () => view('pages/Embeds', { islands: ['/sessioned'] }));
    Route.get('/embeds', () => view('pages/Embeds', { islands: ['/page', '/closure', '/island', '/nowhere'] }));
  });
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, LoggingProvider],
    modules: [defineModule({ name: 'gate', routes })],
    middleware: { global: [GlobalCount], web: [GroupCount] },
  }, { env: { APP_KEY: generateKey(), APP_URL: 'https://marmeon.example' } });
  application.container.scoped(PageSession, () => ({ started: () => false, csrfToken: () => undefined, scope: () => undefined, generation: () => undefined, readAt: () => undefined }));
  const render: SsrRender = async (page, options = {}) => {
    const urls = (page.props as { islands?: string[] }).islands ?? [];
    const results = await Promise.all(urls.map(async (url) => `<island url="${url}">${JSON.stringify(await options.resolveIsland!(url))}</island>`));
    return { html: `<main>shell</main>${results.join('')}` };
  };
  const renderer = createDocumentRenderer({ template: () => FALLBACK_TEMPLATE, ssr: () => render });
  const app = createHttpKernel(application, { renderer, debug: true });
  const production = createHttpKernel(application, { renderer, strictReadOnly: false });
  const reset = () => {
    ran.global = ran.group = ran.route = ran.controller = 0;
  };

  it.each(['/page', '/json', '/closure'])('refuses %s before any middleware and its controller: a 404, marked as the island’s exception', async (path) => {
    reset();
    const response = await app.request(path, { headers: ISLAND });
    expect(response.status).toBe(404);
    expect(response.headers.get('x-marmeon-region-status')).toBe('exception');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')).toContain('x-marmeon-region');
    expect(((await response.json()) as { message: string }).message).toContain(`GET ${path} is no island: no controller class of it calls this.island(…)`);
    expect(ran).toEqual({ global: 0, group: 0, route: 0, controller: 0 });
  });

  it('refuses an unknown path and an unknown framework path before the global middleware, too', async () => {
    reset();
    const response = await app.request('/nowhere', { headers: ISLAND });
    expect([response.status, response.headers.get('x-marmeon-region-status')]).toEqual([404, 'exception']);
    expect(total()).toBe(0);
    expect((await app.request('/_marmeon/nowhere', { headers: ISLAND })).status).toBe(404);
    expect(total()).toBe(0);
  });

  it('answers the same in production for a known route that is no island and for an unknown path — and says nothing', async () => {
    reset();
    const answers = await Promise.all(['/page', '/json', '/nowhere'].map((path) => production.request(path, { headers: ISLAND })));
    const seen = await Promise.all(answers.map(async (r) => [r.status, r.headers.get('x-marmeon-region-status'), r.headers.get('content-type'), r.headers.get('cache-control'), await r.text()]));
    // The unknown path's answer before the gate existed, byte for byte.
    expect(seen[0]).toEqual([404, 'exception', 'application/json', 'no-store', '{"status":404,"title":"Not Found","message":"Not Found","exception":null}']);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
    expect(total()).toBe(0);
  });

  it('refuses an island request to the sitemap and robots.txt before the global middleware', async () => {
    reset();
    for (const path of ['/sitemap.xml', '/robots.txt']) {
      const response = await app.request(path, { headers: ISLAND });
      expect([response.status, response.headers.get('x-marmeon-region-status')]).toEqual([404, 'exception']);
    }
    expect(total()).toBe(0);
    // Without the island header they answer as always, behind the global middleware.
    expect((await app.request('/sitemap.xml')).status).toBe(200);
    expect(ran.global).toBe(1);
  });

  it('logs nothing in production when it refuses a browser’s island request — the path is the requester’s to choose', async () => {
    logged.length = 0;
    for (const path of ['/page', '/nowhere', '/sitemap.xml']) await production.request(path, { headers: ISLAND });
    expect(logged).toEqual([]);
  });

  it('decides before the session does: a route that starts the session and is no island is a 404, not left to the browser', async () => {
    reset();
    const html = await (await app.request('/embeds-session')).text();
    const results = Object.fromEntries([...html.matchAll(/<island url="([^"]+)">(.*?)<\/island>/g)].map(([, url, json]) => [url!, JSON.parse(json!) as RegionResult]));
    expect(results['/sessioned']).toMatchObject({ status: 'exception', failure: { status: 404 } });
    expect(ran.controller).toBe(0);
  });

  it('runs a real island: its route middleware and its controller once each, the global and the group middleware as always', async () => {
    reset();
    const response = await app.request('/island', { headers: ISLAND });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-marmeon-region')).toBe('island');
    expect(ran).toEqual({ global: 1, group: 1, route: 1, controller: 1 });
  });

  it('leaves a request without the island header alone: the page route runs', async () => {
    reset();
    expect((await app.request('/page', { headers: { accept: 'text/html' } })).status).toBe(200);
    expect(ran.controller).toBe(1);
  });

  it('refuses an island that an <Island href> names in-process, before any middleware', async () => {
    reset();
    const response = await app.request('/embeds');
    const results = Object.fromEntries([...(await response.text()).matchAll(/<island url="([^"]+)">(.*?)<\/island>/g)].map(([, url, json]) => [url!, JSON.parse(json!) as RegionResult]));
    expect(results['/page']).toMatchObject({ status: 'exception', failure: { status: 404 } });
    expect(results['/closure']).toMatchObject({ status: 'exception', failure: { status: 404 } });
    expect(results['/nowhere']).toMatchObject({ status: 'exception', failure: { status: 404 } });
    expect(results['/island']).toMatchObject({ status: 'ready', region: { component: 'islands/Real' } });
    // The page itself and the real island ran; the others reached neither middleware nor controller.
    expect(ran.controller).toBe(1);
    expect(ran.route).toBe(1);
  });

  it('says nothing of the refusal in production when an <Island href> names a page', async () => {
    const response = await production.request('/embeds');
    const results = Object.fromEntries([...(await response.text()).matchAll(/<island url="([^"]+)">(.*?)<\/island>/g)].map(([, url, json]) => [url!, JSON.parse(json!) as RegionResult]));
    expect(results['/page']).toEqual({ status: 'exception', failure: { status: 404 } });
    expect(results['/nowhere']).toEqual(results['/page']);
  });
});
