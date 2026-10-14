import { defineRoutes, FRAMEWORK_ROUTES, Router } from '@marmeon/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RouteListCommand } from './commands/route-list.ts';
import { Output } from './output.ts';

function list(router: Router): string {
  const lines: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
    lines.push(String(text));
    return true;
  });
  new RouteListCommand(router).handle({ args: [], options: {}, output: new Output(), root: '/' } as never);
  return lines.join('');
}

afterEach(() => vi.restoreAllMocks());

describe('route:list access column', () => {
  it('shows framework only for routes loaded with the framework marker, not for a hand-set `reserved`', () => {
    const router = new Router();
    router.load({ framework: FRAMEWORK_ROUTES } as never, defineRoutes((Route) => Route.get('/_marmeon/own', () => 'x')));
    router.load({} as never, defineRoutes((Route) => Route.get('/forged', () => 'x')));
    router.routes.find((route) => route.path === '/forged')!.reserved = true;
    const out = list(router);
    expect(out).toMatch(/\/_marmeon\/own\s.*\sframework\s/);
    expect(out).toMatch(/\/forged\s.*\snone\s/);
    expect(out).not.toMatch(/\/forged\s.*\sframework\s/);
  });
});
