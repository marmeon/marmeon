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

  it('finds none when a rest route comes after a route with a parameter: it also answers the longer paths', () => {
    expect(load(open((Route) => {
      Route.get('/notes/:id', () => 'a');
      Route.get('/notes/:path*', () => 'b');
    })).routeConflicts()).toEqual([]);
  });

  it.each(['/notes/:id', '/notes', '/notes/a/b'])('finds %s behind an earlier rest route with the same prefix', (later) => {
    const router = load(open((Route) => {
      Route.get('/notes/:path*', () => 'a');
      Route.get(later, () => 'b');
    }));
    expect(router.routeConflicts()).toMatchObject([{ kind: 'rest', methods: ['GET'] }]);
    expect(describeRouteConflict(router.routeConflicts()[0]!)).toContain('takes the rest of that path');
  });

  it('finds none for a route outside the prefix of an earlier rest route', () => {
    expect(load(open((Route) => {
      Route.get('/a/:path*', () => 'a');
      Route.get('/b/x', () => 'b');
      Route.get('/ab', () => 'c');
    })).routeConflicts()).toEqual([]);
  });

  it('names the methods that never reach a later route, and not the ones it still answers', () => {
    const router = load(open((Route) => {
      Route.get('/x', () => 'a');
      Route.match(['GET', 'POST'], '/x', () => 'b');
    }));
    const message = describeRouteConflict(router.routeConflicts()[0]!);
    expect(message).toContain('GET|POST /x');
    expect(message).toContain('never answers for GET:');
    expect(message).toContain('or the methods of one of them');
  });

  it('names the earliest route that takes the methods, not a later one that is dead itself', () => {
    const router = load(open((Route) => {
      Route.get('/a/:p*', () => 'a');
      Route.get('/a/x', () => 'b');
      Route.get('/a/x', () => 'c');
    }));
    expect(router.routeConflicts().map((conflict) => [conflict.first, conflict.second])).toEqual([
      [router.routes[0], router.routes[1]],
      [router.routes[0], router.routes[2]],
    ]);
  });

  it('reports a route behind two rest routes once, against the first', () => {
    const router = load(open((Route) => {
      Route.get('/a/:p*', () => 'a');
      Route.get('/a/b/:q*', () => 'b');
      Route.get('/a/b/c', () => 'c');
    }));
    expect(router.routeConflicts().map((conflict) => [conflict.first, conflict.second])).toEqual([
      [router.routes[0], router.routes[1]],
      [router.routes[0], router.routes[2]],
    ]);
  });

  it('calls a route dead when its methods, HEAD counted as GET, are all taken', () => {
    const router = load(open((Route) => {
      Route.get('/x', () => 'a');
      Route.match(['GET', 'HEAD'], '/x', () => 'b');
    }));
    const message = describeRouteConflict(router.routeConflicts()[0]!);
    expect(message).toContain('never answers:');
    expect(message).not.toContain('or the methods');
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
