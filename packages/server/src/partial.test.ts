import { createApplication, defineModule } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { defer, HttpServiceProvider, optional, view, type PageObject } from '@marmeon/http';
import { openRoutes } from './test-helpers/open-routes.ts';
import { describe, expect, it } from 'vitest';
import { createHttpKernel } from './kernel.ts';
import { PAGE_HEADER, PROTOCOL_VERSION } from '@marmeon/http/protocol';


describe('createHttpKernel — partial reloads and deferred props', async () => {
  const computed: Record<string, number> = {};
  const count = (name: string) => (computed[name] = (computed[name] ?? 0) + 1);
  /** While set, the deferred prop waits for it — the first response must not. */
  let hold: Promise<void> | undefined;

  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider],
    modules: [
      defineModule({
        name: 'pages',
        routes: openRoutes((Route) => {
          Route.get('/users/1', () =>
            view('users/Show', {
              name: 'Ada',
              expensive: () => (count('expensive'), 42),
              stats: optional(() => (count('stats'), { links: 3 })),
              activity: defer(async () => {
                count('activity');
                await hold;
                return ['signed in'];
              }),
            }),
          );
        }),
      }),
    ],
  }, { env: { APP_KEY: generateKey() } });
  const app = createHttpKernel(application);

  const visit = (headers: Record<string, string> = {}) => app.request('/users/1', { headers: { [PAGE_HEADER]: PROTOCOL_VERSION, ...headers } });
  const json = async (response: Response) => (await response.json()) as PageObject;

  it('does not compute a prop the partial reload does not ask for', async () => {
    for (const key of Object.keys(computed)) delete computed[key];
    const page = await json(await visit({ 'x-marmeon-partial-component': 'users/Show', 'x-marmeon-partial-data': 'stats' }));
    expect(page.props).toEqual({ stats: { links: 3 } });
    expect(computed).toEqual({ stats: 1 }); // not `expensive`, not `activity`
  });

  it('answers a partial reload for another component in full', async () => {
    for (const key of Object.keys(computed)) delete computed[key];
    const page = await json(await visit({ 'x-marmeon-partial-component': 'users/Edit', 'x-marmeon-partial-data': 'stats' }));
    expect(page.props).toEqual({ name: 'Ada', expensive: 42 });
    expect(page.deferredProps).toEqual({ default: ['activity'] });
    expect(computed).toEqual({ expensive: 1 });
  });

  it('computes every prop for a document, and refuses partial headers without the protocol version (409)', async () => {
    const html = await (await app.request('/users/1')).text();
    expect(html).toContain('"expensive":42');
    expect(html).not.toContain('"stats"');
    const refused = await app.request('/users/1', { headers: { 'x-marmeon-partial-component': 'users/Show', 'x-marmeon-partial-data': 'stats' } });
    expect(refused.status).toBe(409);
  });

  it('sends the page without a deferred prop at once — loading it is a partial reload of its own', async () => {
    for (const key of Object.keys(computed)) delete computed[key];
    const gate = Promise.withResolvers<void>();
    hold = gate.promise;
    try {
      // The deferred prop is held back: a first response that waited for it would never come.
      const first = await json(await visit());
      expect(first.props).toEqual({ name: 'Ada', expensive: 42 });
      expect(first.deferredProps).toEqual({ default: ['activity'] });
      expect(computed.activity).toBeUndefined();

      let settled = false;
      const reloading = visit({ 'x-marmeon-partial-component': 'users/Show', 'x-marmeon-partial-data': 'activity' }).then((response) => {
        settled = true;
        return response;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);
      gate.resolve();
      const deferred = await json(await reloading);
      expect(deferred.props).toEqual({ activity: ['signed in'] });
      expect(deferred.deferredProps).toBeUndefined();
    } finally {
      gate.resolve();
      hold = undefined;
    }
  });

  it('varies page responses by the partial headers, so no cache answers one with the other', async () => {
    const vary = (await visit()).headers.get('vary')?.split(',').map((name) => name.trim());
    expect(vary).toEqual(['x-marmeon', 'x-marmeon-region', 'x-marmeon-partial-component', 'x-marmeon-partial-data', 'x-marmeon-partial-except', 'purpose', 'x-marmeon-once', 'x-marmeon-once-scope']);
  });
});
