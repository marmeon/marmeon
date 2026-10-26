// @vitest-environment happy-dom
// @vitest-environment-options { "url": "https://app.test/a" }
import { Suspense } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { untilOutsideAct } from './test-helpers/settle.ts';
import { defaultTitle, Head, HeadContext, sweepServerTags } from './head.tsx';
import { HeadRegistry } from './head-fields.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
});

describe('<Head> hydrating after the first pass', () => {
  it('takes over the script of a <Head> in a Suspense boundary that hydrates later, instead of writing it again', async () => {
    document.head.innerHTML =
      '<script type="text/plain" src="/shell.js" data-marmeon-head="ssr-tag"></script>' +
      '<script type="text/plain" src="/inner.js" data-marmeon-head="ssr-tag"></script>' +
      '<link rel="alternate" href="/inner" data-marmeon-head="ssr-tag"/><style data-marmeon-head="ssr-tag">a{}</style>';
    const inner = [...document.head.querySelectorAll('[data-marmeon-head]')].slice(1);
    const registry = new HeadRegistry();
    const tree = () => (
      <HeadContext.Provider value={{ template: defaultTitle, fields: registry }}>
        <Head title="A">
          <script type="text/plain" src="/shell.js" />
        </Head>
        <Suspense fallback={null}>
          <Head>
            <script type="text/plain" src="/inner.js" />
            <link rel="alternate" href="/inner" />
            <style>{'a{}'}</style>
          </Head>
        </Suspense>
      </HeadContext.Provider>
    );
    const container = document.body.appendChild(document.createElement('div'));
    container.innerHTML = renderToString(tree());
    hydrateRoot(container, tree());
    // Not in `act`: the test hydrates outside the act environment, so it polls for the Suspense boundary to hydrate.
    await untilOutsideAct(() => expect([...document.head.querySelectorAll('[data-marmeon-head="client"]')].slice(1)).toEqual(inner));
    expect(document.head.querySelectorAll('script[src="/inner.js"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('[data-marmeon-head="ssr-tag"]')).toHaveLength(0);
  });

  it('leaves a tag no <Head> took over until the app sweeps', () => {
    document.head.innerHTML = '<script type="text/plain" src="/x.js" data-marmeon-head="ssr-tag"></script>';
    expect(document.head.querySelector('script')).not.toBeNull();
    sweepServerTags();
    expect(document.head.querySelector('script')).toBeNull();
  });
});
