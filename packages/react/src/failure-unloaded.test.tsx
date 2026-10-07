// @vitest-environment happy-dom
import type { VisitException } from '@marmeon/http/client';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, RenderErrorFallback, VisitFailure } from './fallbacks.tsx';
import type { ResolvePage } from './pages.ts';

// The failure chunk (E202) cannot load — offline, or a proxy answers every asset with a 502: what a failure shows must not fail too.
vi.mock('./failure.tsx', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const resolve = (async () => {
  throw new Error('no pages here');
}) as unknown as ResolvePage;
let root: Root | undefined;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
});

async function render(node: React.ReactNode): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
  // The import's rejection, then React's retry of the suspended lazy component.
  for (let tries = 0; tries < 20; tries++) await act(async () => void (await new Promise((done) => setTimeout(done, 5))));
  return container;
}

describe('when the failure chunk cannot load', () => {
  it('a 5xx shows the notice of an unreachable server — the page and the app stay', async () => {
    const failure = { type: 'server', status: 502, page: undefined, html: '<h1>Bad gateway</h1>' } as unknown as VisitException;
    const container = await render(
      <>
        <p data-page="">page</p>
        <VisitFailure failure={failure} resolve={resolve} onDismiss={() => {}} />
      </>,
    );
    expect(container.querySelector('[data-marmeon-failure="network"]')?.textContent).toContain('could not be reached');
    expect(container.querySelector('[data-page]')).not.toBeNull();
  });

  it('a page that threw shows nothing in its place — no error of its own for the boundary above', async () => {
    const caught = vi.fn();
    const container = await render(
      <ErrorBoundary resetKey={1} fallback={() => <p data-outer="">outer</p>} onError={caught}>
        <p data-page="">page</p>
        <RenderErrorFallback resolve={resolve} error={new Error('the page threw')} />
      </ErrorBoundary>,
    );
    expect(caught).not.toHaveBeenCalled();
    expect(container.querySelector('[data-page]')).not.toBeNull();
    expect(container.querySelector('[data-outer]')).toBeNull();
  });
});
