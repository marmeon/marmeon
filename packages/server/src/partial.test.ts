import { createApplication, defineModule } from '@bespokecore/core';
import { EncryptionServiceProvider, generateKey } from '@bespokecore/encryption';
import { defer, HttpServiceProvider, optional, view, type PageObject } from '@bespokecore/http';
import { defineRoutes } from '@bespokecore/router';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';

/** How long the deferred prop takes — the first response must not wait for it. */
const SLOW = 400;

describe('createHttpKernel — partial reloads and deferred props', async () => {
  const computed: Record<string, number> = {};
  const count = (name: string) => (computed[name] = (computed[name] ?? 0) + 1);

  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey() },
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [
      defineModule({
        name: 'pages',
        routes: defineRoutes((Route) => {
          Route.get('/users/1', () =>
            view('users/Show', {
              name: 'Ada',
              expensive: () => (count('expensive'), 42),
              stats: optional(() => (count('stats'), { links: 3 })),
              activity: defer(async () => {
                count('activity');
                await new Promise((done) => setTimeout(done, SLOW));
                return ['signed in'];
              }),
            }),
          );
        }),
      }),
    ],
  });
  const app = createHttpKernel(application);

  const visit = (headers: Record<string, string> = {}) => app.request('/users/1', { headers: { 'x-bespoke': 'true', ...headers } });
  const json = async (response: Response) => (await response.json()) as PageObject;

  it('does not compute a prop the partial reload does not ask for', async () => {
    for (const key of Object.keys(computed)) delete computed[key];
    const page = await json(await visit({ 'x-bespoke-partial-component': 'users/Show', 'x-bespoke-partial-data': 'stats' }));
    expect(page.props).toEqual({ stats: { links: 3 } });
    expect(computed).toEqual({ stats: 1 }); // not `expensive`, not `activity`
  });

  it('answers a partial reload for another component in full', async () => {
    for (const key of Object.keys(computed)) delete computed[key];
    const page = await json(await visit({ 'x-bespoke-partial-component': 'users/Edit', 'x-bespoke-partial-data': 'stats' }));
    expect(page.props).toEqual({ name: 'Ada', expensive: 42 });
    expect(page.deferredProps).toEqual({ default: ['activity'] });
    expect(computed).toEqual({ expensive: 1 });
  });

  it('ignores partial headers on a full page load (the document needs every prop)', async () => {
    const response = await app.request('/users/1', { headers: { 'x-bespoke-partial-component': 'users/Show', 'x-bespoke-partial-data': 'stats' } });
    const html = await response.text();
    expect(html).toContain('"expensive":42');
    expect(html).not.toContain('"stats"');
  });

  it('sends the page without a deferred prop at once — loading it is a partial reload of its own', async () => {
    for (const key of Object.keys(computed)) delete computed[key];
    let started = performance.now();
    const first = await json(await visit());
    const firstTook = performance.now() - started;
    expect(first.props).toEqual({ name: 'Ada', expensive: 42 });
    expect(first.deferredProps).toEqual({ default: ['activity'] });
    expect(computed.activity).toBeUndefined();
    expect(firstTook).toBeLessThan(SLOW / 2);

    started = performance.now();
    const deferred = await json(await visit({ 'x-bespoke-partial-component': 'users/Show', 'x-bespoke-partial-data': 'activity' }));
    expect(performance.now() - started).toBeGreaterThanOrEqual(SLOW - 5);
    expect(deferred.props).toEqual({ activity: ['signed in'] });
    expect(deferred.deferredProps).toBeUndefined();
  });

  it('varies page responses by the partial headers, so no cache answers one with the other', async () => {
    const vary = (await visit()).headers.get('vary')?.split(',').map((name) => name.trim());
    expect(vary).toEqual(['x-bespoke', 'x-bespoke-partial-component', 'x-bespoke-partial-data', 'x-bespoke-partial-except']);
  });
});
