import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { Router } from '@marmeon/router';
import { Hono } from 'hono';
import { RegExpRouter } from 'hono/router/reg-exp-router';
import { TrieRouter } from 'hono/router/trie-router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { honoPath } from './route-pattern.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

describe('honoPath', () => {
  it.each([
    ['/b/:id{new|edit}', '/b/:id{(?:new|edit)}'],
    ['/b/:id{new|edit}/x', '/b/:id{(?:new|edit)}/x'],
    ['/:a{x|y}/:b{[0-9]+|z}', '/:a{(?:x|y)}/:b{(?:[0-9]+|z)}'],
    ['/b/:id{a{2}|b}', '/b/:id{(?:a{2}|b)}'],
    ['/b/:id{a\\|b|c}', '/b/:id{(?:a\\|b|c)}'],
    ['/b/:id{new|edit}?', '/b/:id{(?:new|edit)}?'],
    ['/b/:id{x|[}]}', '/b/:id{(?:x|[}])}'],
  ])('encloses a constraint with a top-level alternative: %s', (path, expected) => {
    expect(honoPath(path)).toBe(expected);
  });

  it.each([
    '/notes',
    '/:page{.+}',
    '/notes/:note{[0-9]+}',
    '/:path{.*\\.md}',
    '/:file{[a-z0-9-]+\\.md}',
    '/:team{[a-z]+}/:token{[a-z]+}?',
    '/b/:id{(new|edit)}',
    '/b/:id{(?:new|edit)}',
    '/b/:id{[a|b]+}',
    '/b/:id{a\\|b}',
    '/b/:id{x{2}}',
    '/b/:id{x|(}',
    '/files/*',
  ])('leaves %s as it is', (path) => {
    expect(honoPath(path)).toBe(path);
  });
});

describe('a constraint with alternatives', () => {
  const probe = (path: string, kind: 'reg-exp' | 'trie', wrap = true) => {
    const app = new Hono({ router: kind === 'trie' ? new TrieRouter() : new RegExpRouter() });
    app.get(wrap ? honoPath(path) : path, (c) => c.text(JSON.stringify(c.req.param())));
    return async (url: string) => {
      const response = await app.request(url);
      return response.status === 200 ? await response.text() : response.status;
    };
  };

  it('is matched by its prefix on the trie router when left bare', async () => {
    expect(await probe('/b/:id{new|edit}', 'trie', false)('/b/newevil')).toBe('{"id":"new"}');
  });

  it.each(['reg-exp', 'trie'] as const)('is matched as a whole by the %s router', async (kind) => {
    const get = probe('/b/:id{new|edit}', kind);
    expect(await get('/b/new')).toBe('{"id":"new"}');
    expect(await get('/b/edit')).toBe('{"id":"edit"}');
    for (const url of ['/b/newevil', '/b/xedit', '/b/new/x', '/b/evilnew', '/b/']) expect(await get(url)).toBe(404);
  });

  it('is matched as a whole when a literal follows it', async () => {
    const get = probe('/b/:id{new|edit}/x', 'trie');
    expect(await get('/b/edit/x')).toBe('{"id":"edit"}');
    expect(await get('/b/newevil/x')).toBe(404);
  });

  it('is matched as a whole when optional', async () => {
    const get = probe('/b/:id{new|edit}?', 'trie');
    expect(await get('/b/new')).toBe('{"id":"new"}');
    expect(await get('/b/newevil')).toBe(404);
  });

  it('leaves the other constraints of the repository working on the trie router', async () => {
    const digits = probe('/n/:note{[0-9]+}', 'trie');
    expect(await digits('/n/42')).toBe('{"note":"42"}');
    expect(await digits('/n/4x')).toBe(404);
    const markdown = probe('/:path{.*\\.md}', 'trie');
    expect(await markdown('/a.md')).toBe('{"path":"a.md"}');
    expect(await markdown('/a.mdx')).toBe(404);
    const rest = probe('/:page{.+}', 'trie');
    expect(await rest('/a/b')).toBe('{"page":"a/b"}');
  });
});

describe('a constraint with alternatives in the HTTP kernel', () => {
  const build = async (routes: ReturnType<typeof openRoutes>) => {
    const app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider],
      modules: [defineModule({ name: 'alternatives', routes })],
    }, { env: { APP_KEY: generateKey(), LOG_LEVEL: 'silent' } });
    return { kernel: createHttpKernel(app), router: app.container.make(Router) };
  };

  it('answers the whole alternative and keeps the path as written', async () => {
    const { kernel, router } = await build(
      openRoutes((Route) => {
        Route.get('/b/:id{new|edit}', (ctx: { params: { id: string } }) => `id=${ctx.params.id}`);
        // A second constraint at the same position is more than the RegExpRouter takes, so the TrieRouter answers.
        Route.get('/b/:id{[0-9]+}', (ctx: { params: { id: string } }) => `number=${ctx.params.id}`);
        Route.get('/c/:page{.+}', () => 'rest');
      }),
    );
    expect(await (await kernel.request('/b/7')).text()).toBe('number=7');
    expect(await (await kernel.request('/b/new')).text()).toBe('id=new');
    expect(await (await kernel.request('/b/edit')).text()).toBe('id=edit');
    for (const url of ['/b/newevil', '/b/xedit', '/b/new/x']) expect((await kernel.request(url)).status).toBe(404);
    expect(await (await kernel.request('/c/a/b')).text()).toBe('rest');
    expect(router.routes.map((route) => route.path)).toContain('/b/:id{new|edit}');
  });
});

// The router's fixture table, loaded by path: a package may not import another package's sources, and the build would refuse it.
const { ROUTE_PATTERNS } = (await import(new URL('../../router/src/__fixtures__/route-patterns.ts', import.meta.url).href)) as {
  ROUTE_PATTERNS: readonly { pattern: string; matches: readonly { path: string; params: Record<string, string> }[]; misses: readonly string[] }[];
};

describe('the patterns every place reads', () => {
  it.each(['reg-exp', 'trie'] as const)('are matched by the %s router as the fixture says', async (kind) => {
    for (const { pattern, matches, misses } of ROUTE_PATTERNS) {
      const app = new Hono({ router: kind === 'trie' ? new TrieRouter() : new RegExpRouter() });
      app.get(honoPath(pattern), (c) => c.text(JSON.stringify(c.req.param())));
      for (const { path, params } of matches) {
        const response = await app.request(path);
        expect([pattern, path, response.status, response.status === 200 ? JSON.parse(await response.text()) : null]).toEqual([pattern, path, 200, params]);
      }
      for (const path of misses) expect([pattern, path, (await app.request(path)).status]).toEqual([pattern, path, 404]);
    }
  });
});
