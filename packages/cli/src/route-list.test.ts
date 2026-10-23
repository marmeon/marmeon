import { defineRoutes, describeAccess, everyone, Router } from '@marmeon/router';
import { FRAMEWORK_ROUTES } from '@marmeon/router/internal';
import { readdirSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteListCommand } from './commands/route-list.ts';
import { Output } from './output.ts';

function list(router: Router, options: Record<string, boolean> = {}): string {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
    lines.push(String(text));
    return true;
  });
  new RouteListCommand(router).handle({ args: [], options, output: new Output(), root: '/' } as never);
  return lines.join('');
}

afterEach(() => vi.restoreAllMocks());

describe('route:list access column', () => {
  it('shows framework only for routes loaded with the framework marker, not for a hand-set `reserved` (which a loaded route refuses)', () => {
    const router = new Router();
    router.load({ framework: FRAMEWORK_ROUTES } as never, defineRoutes((Route) => Route.get('/_marmeon/own', () => 'x')));
    router.load({} as never, defineRoutes((Route) => {
      Route.get('/forged', () => 'x').reserved = true;
    }));
    expect(() => {
      router.routes.find((route) => route.path === '/forged')!.reserved = false; // a loaded route is frozen
    }).toThrow(TypeError);
    const out = list(router);
    expect(out).toMatch(/\/_marmeon\/own\s.*\sframework\s/);
    expect(out).toMatch(/\/forged\s.*\snone\s/);
    expect(out).not.toMatch(/\/forged\s.*\sframework\s/);
  });
});

describe('route:list --json', () => {
  const router = new Router();
  router.load({ framework: FRAMEWORK_ROUTES } as never, defineRoutes((Route) => Route.get('/_marmeon/own', () => 'x')));
  router.load({} as never, defineRoutes((Route) => Route.get('/open', () => 'x').name('open')));
  const Named = (_request: unknown, next: () => unknown) => next();
  router.load(
    { group: 'web' } as never,
    defineRoutes((Route) =>
      Route.middleware(Named as never)
        .authorize(describeAccess(() => true, 'can Note.view(note)'))
        .get('/grouped', () => 'x'),
    ),
  );

  const publicRouter = new Router();
  const Users = { find: () => undefined };
  publicRouter.load(
    {} as never,
    defineRoutes((Route) => [
      Route.authorize(everyone).bind('user', Users as never, { public: true }).get('/users/:user', () => 'x'),
      Route.authorize(everyone).get('/about', () => 'x'),
      Route.authorize(describeAccess(() => true, 'can Team.view(team)'))
        .bind('team', Users as never)
        .bind('note', Users as never, { public: true })
        .get('/teams/:team/notes/:note', () => 'x'),
    ]),
  );

  // One router per stored file: a fixture in the directory that no router here matches fails the test.
  const routers: Record<string, Router> = { 'v1.json': router, 'v1-public.json': publicRouter };
  const directory = new URL('./__fixtures__/formats/cli-route-list/', import.meta.url);

  it('prints exactly one document with the format first, matching every stored file', () => {
    const files = readdirSync(directory);
    expect([...files].sort()).toEqual(Object.keys(routers).sort());
    for (const file of files) {
      const out = list(routers[file]!, { json: true });
      const document = JSON.parse(out) as Record<string, unknown>;
      expect(Object.keys(document)[0]).toBe('format');
      expect(out.endsWith('\n')).toBe(true);
      expect(document).toMatchObject(JSON.parse(readFileSync(new URL(file, directory), 'utf8')));
    }
  });

  it('lists the bindings that make records public, and an empty list for a route without', () => {
    const routes = (JSON.parse(list(publicRouter, { json: true })) as { routes: { path: string; publicBindings: string[] }[] }).routes;
    expect(routes.map((route) => [route.path, route.publicBindings])).toEqual([['/users/:user', ['user']], ['/about', []], ['/teams/:team/notes/:note', ['note']]]);
    const plain = JSON.parse(list(router, { json: true })) as { routes: { publicBindings: string[] }[] };
    expect(plain.routes.every((route) => route.publicBindings.length === 0)).toBe(true);
  });

  it('shows them next to the checks in the table', () => {
    const out = list(publicRouter);
    expect(out).toMatch(/\/users\/:user\s.*\severyone \(public: user\)\s/);
    expect(out).toMatch(/\/about\s.*\severyone\s+Closure/);
    expect(out).not.toMatch(/\/about\s.*public/);
    expect(out).toMatch(/\/teams\/:team\/notes\/:note\s.*\scan Team\.view\(team\) \(public: note\)\s/);
  });

  it('prints the table without --json', () => {
    expect(list(router)).toMatch(/^METHOD\s+PATH/);
  });
});
