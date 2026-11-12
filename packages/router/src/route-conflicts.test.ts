import { Redactor } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { everyone } from './access.ts';
import { FRAMEWORK_ROUTES } from './internal.ts';
import { defineRoutes, describeRouteConflict, Router, routeShape, type RouteDefinitions } from './router.ts';

const open = (register: (Route: Parameters<RouteDefinitions['register']>[0]) => void): RouteDefinitions => defineRoutes((Route) => register(Route.authorize(everyone)));
const load = (...files: RouteDefinitions[]) => new Router().load(...files);
const shown = (router: Router) => router.routeConflicts().map(({ first, second, methods }) => `${methods.join('|')} ${first.path} < ${second.path}`);

describe('routeShape', () => {
  it('drops the names of parameters and keeps constraints, optional marks and text', () => {
    expect(routeShape('/notes/:id')).toBe(routeShape('/notes/:note'));
    expect(routeShape('/notes/:id{[0-9]+}')).not.toBe(routeShape('/notes/:id'));
    expect(routeShape('/notes/:id{[0-9]+}')).toBe(routeShape('/notes/:n{[0-9]+}'));
    expect(routeShape('/a/:x?')).not.toBe(routeShape('/a/:x'));
    expect(routeShape('/a/:x')).not.toBe(routeShape('/b/:x'));
  });
});

describe('Router.routeConflicts()', () => {
  it('finds the same method and path in two files, the earlier one first', () => {
    const router = load(open((Route) => void Route.get('/notes', () => 'a')), open((Route) => void Route.get('/notes', () => 'b')));
    const [conflict] = router.routeConflicts();
    expect(router.routeConflicts()).toHaveLength(1);
    expect(conflict!.first).toBe(router.routes[0]);
    expect(conflict!.second).toBe(router.routes[1]);
    expect(conflict!.methods).toEqual(['GET']);
  });

  it('finds two routes whose parameters have other names', () => {
    expect(shown(load(open((Route) => {
      Route.get('/notes/:id', () => 'a');
      Route.get('/notes/:note', () => 'b');
    })))).toEqual(['GET /notes/:id < /notes/:note']);
  });

  it('finds none when the constraints, the methods or the paths differ', () => {
    const router = load(open((Route) => {
      Route.get('/notes/:id{[0-9]+}', () => 'a');
      Route.get('/notes/:id', () => 'b');
      Route.post('/notes/:id', () => 'c');
      Route.get('/notes', () => 'd');
      Route.get('/notes/:id/edit', () => 'e');
    }));
    expect(router.routeConflicts()).toEqual([]);
  });

  it('names the methods any() shares with a get()', () => {
    const router = load(open((Route) => {
      Route.get('/ping', () => 'a');
      Route.any('/ping', () => 'b');
    }));
    expect(shown(router)).toEqual(['GET /ping < /ping']);
  });

  it('counts HEAD as GET', () => {
    const router = load(open((Route) => {
      Route.get('/ping', () => 'a');
      Route.match(['HEAD'], '/ping', () => 'b');
    }));
    expect(shown(router)).toEqual(['GET /ping < /ping']);
  });

  it('does not let a route of HEAD alone keep a later GET route from answering', () => {
    const router = load(open((Route) => {
      Route.match(['HEAD'], '/x', () => 'a');
      Route.get('/x', () => 'b');
    }));
    expect(router.routeConflicts()).toEqual([]);
  });

  it('reports a third route once, against the first, when the second already shares its method', () => {
    const router = load(open((Route) => {
      Route.get('/x', () => 'a');
      Route.any('/x', () => 'b');
      Route.get('/x', () => 'c');
    }));
    const [, third] = router.routeConflicts();
    expect(router.routeConflicts()).toHaveLength(2);
    expect(third).toMatchObject({ first: router.routes[0], second: router.routes[2], methods: ['GET'] });
  });

  it('finds none between a localized route and a free parameter that only looks like its locale', () => {
    expect(load(open((Route) => {
      Route.localized().get('/', () => 'a');
      Route.localized().get('/:slug', () => 'b');
    })).routeConflicts()).toEqual([]);
    expect(load(open((Route) => {
      Route.localized().get('/', () => 'a');
      Route.get('/:page', () => 'b');
    })).routeConflicts()).toEqual([]);
    expect(load(open((Route) => {
      Route.localized().get('/about', () => 'a');
      Route.get('/:lang/about', () => 'b');
    })).routeConflicts()).toEqual([]);
  });

  it('reports a route against each earlier one for the methods it shares with them', () => {
    const router = load(open((Route) => {
      Route.get('/x', () => 'a');
      Route.post('/x', () => 'b');
      Route.match(['GET', 'POST', 'PUT'], '/x', () => 'c');
    }));
    expect(router.routeConflicts().map((conflict) => conflict.methods)).toEqual([['GET'], ['POST']]);
  });

  it('finds an app route on the address without a locale of a localized route, which comes later', () => {
    const router = load(open((Route) => {
      Route.localized().get('/about', () => 'a');
      Route.get('/about', () => 'b');
    }));
    const [conflict] = router.routeConflicts();
    expect(router.routeConflicts()).toHaveLength(1);
    expect(conflict!.first.path).toBe('/about');
    expect(conflict!.second.generatedFrom?.path).toBe('/:locale/about');
    expect(describeRouteConflict(conflict!)).toContain('the address without a locale of /:locale/about');
  });

  it('reports two localized routes once, not again for their addresses without a locale', () => {
    const router = load(open((Route) => {
      Route.localized().get('/about', () => 'a');
      Route.localized().get('/about', () => 'b');
    }));
    expect(shown(router)).toEqual(['GET /:locale/about < /:locale/about']);
  });

  it('finds a route of a package that loads after the modules', () => {
    const router = load(open((Route) => void Route.get('/health', () => 'app')));
    router.load(open((Route) => void Route.get('/health', () => 'package')));
    expect(shown(router)).toEqual(['GET /health < /health']);
  });

  it('leaves the framework’s own routes out', () => {
    const router = new Router();
    router.load({ framework: FRAMEWORK_ROUTES }, defineRoutes((Route) => {
      Route.authorize(everyone).get('/_marmeon/x', () => 'a');
      Route.authorize(everyone).get('/_marmeon/x', () => 'b');
    }));
    expect(router.routeConflicts()).toEqual([]);
  });

  it('names both routes with the place each was registered, and masks a segment that looks like a secret through the caller’s redactor', () => {
    const router = load(open((Route) => {
      Route.get('/hooks/zz-1/:token', () => 'a');
      Route.get('/hooks/zz-1/:other', () => 'b');
    }));
    const masked = new Redactor({ patterns: [/zz-\d+/] });
    const message = describeRouteConflict(router.routeConflicts()[0]!, (route) => masked.path(route.path, route.path));
    expect(message).toMatch(/^GET \/hooks\/\[redacted\]\/:other \(.*route-conflicts\.test\.ts:\d+\) never answers: GET \/hooks\/\[redacted\]\/\[redacted\] \(.*route-conflicts\.test\.ts:\d+\) has the same path and is registered first/);
    expect(message).toContain('docs/routing.md#route-order');
  });
});
