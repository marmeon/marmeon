import { defineRoutes, describeAccess, Router } from '@marmeon/router';
import { FRAMEWORK_ROUTES } from '@marmeon/router/internal';
import { readFileSync } from 'node:fs';
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

  it('prints exactly one document with the format first, matching the stored format', () => {
    const out = list(router, { json: true });
    const document = JSON.parse(out) as Record<string, unknown>;
    expect(Object.keys(document)[0]).toBe('format');
    expect(out.endsWith('\n')).toBe(true);
    const fixture = JSON.parse(readFileSync(new URL('./__fixtures__/formats/cli-route-list/v1.json', import.meta.url), 'utf8'));
    expect(document).toMatchObject(fixture);
  });

  it('prints the table without --json', () => {
    expect(list(router)).toMatch(/^METHOD\s+PATH/);
  });
});
