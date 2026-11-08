import { describe, expect, it, vi } from 'vitest';

const run = vi.hoisted(() => vi.fn());
vi.mock('./spawn.ts', () => ({ runMarmeonJson: run }));

const { ROUTES_TOOL } = await import('./mcp/routes.ts');

const context = { root: '/', signal: new AbortController().signal };
const answer = (over: Record<string, unknown>) => run.mockResolvedValueOnce({ code: 0, document: undefined, stderrTail: '', timedOut: false, tooLarge: false, ...over });

describe('routes when route:list answers oddly', () => {
  it('says that something wrote to stdout when it exits 0 without one JSON document', async () => {
    answer({});
    const result = await ROUTES_TOOL.run({}, context);
    expect(result).toEqual({ failure: expect.stringContaining('did not print one JSON document') });
    expect(JSON.stringify(result)).not.toContain('update marmeon');
  });

  it('says to update marmeon for a document of another format', async () => {
    answer({ document: { format: 2, routes: [] } });
    expect(await ROUTES_TOOL.run({}, context)).toEqual({ failure: expect.stringContaining('update marmeon') });
  });

  it('passes on the end of stderr when the app does not start', async () => {
    answer({ code: 1, stderrTail: 'boom\n' });
    expect(await ROUTES_TOOL.run({}, context)).toEqual({ failure: 'The app did not start: boom' });
  });
});

describe('routes that are islands', () => {
  it('passes the island field of route:list on, for an island and for a route that is none', async () => {
    const entry = (path: string, island: boolean) => ({ methods: ['GET'], path, name: null, island });
    answer({ document: { format: 1, routes: [entry('/islands/sign-ins', true), entry('/dashboard', false)] } });
    const result = (await ROUTES_TOOL.run({}, context)) as unknown as { routes: { path: string; island: boolean }[] };
    expect(result.routes.map((route) => [route.path, route.island])).toEqual([['/islands/sign-ins', true], ['/dashboard', false]]);
  });
});
