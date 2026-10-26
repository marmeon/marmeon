import { afterEach, describe, expect, it, vi } from 'vitest';
import { isDevelopment } from './document.ts';
import type { DevtoolsGlobal } from './features/devtools.ts';
import { applyPatches } from './patches.ts';
import { createPoll } from './poll.ts';
import { resolveRoute } from './routes.ts';

// development branches ask `NODE_ENV === 'development' || === 'test'` — positively. A client build has the value
// folded in by Vite; server rendering and these tests read it at run time, so a missing NODE_ENV (production) must take the
// production branch: the short code, no explanation, no devtools hook — and so must, fail-closed, a value the start refuses but a
// hand-made build could still fold in (a typo, `staging`). (Before: `!== 'production'` — a missing NODE_ENV got every development branch.)
afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__;
});

const message = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('did not throw');
};

/** What the client says with `NODE_ENV` set so — a missing one stubbed as `undefined`. */
function observe(value: string | undefined) {
  vi.stubEnv('NODE_ENV', value);
  const patched = vi.fn();
  (globalThis as DevtoolsGlobal).__MARMEON_DEVTOOLS_HOOK__ = { patches: patched };
  const target = { add: () => 7, settle: () => {} } as unknown as Parameters<typeof applyPatches>[0][number]['target'];
  applyPatches([{ target, patch: (props) => props }]);
  return {
    development: isDevelopment(),
    c1: message(() => resolveRoute(undefined, 'people.show')),
    c2: message(() => resolveRoute({}, 'people.show')),
    c5: message(() => createPoll(async () => {}, { intervalMs: 0 })),
    hook: patched.mock.calls.length,
  };
}

describe('NODE_ENV is checked positively in the client core', () => {
  it.each([[undefined], ['production'], ['Development'], ['dev'], ['staging']])('NODE_ENV=%j takes the production branch: short codes, no devtools hook', (value) => {
    const seen = observe(value);
    const expected = { development: false, c1: '[marmeon:C1] people.show', c2: '[marmeon:C2] people.show', c5: '[marmeon:C5] 0', hook: 0 };
    for (const [key, short] of Object.entries(expected)) expect(seen[key as keyof typeof seen], `NODE_ENV=${value} ${key}`).toBe(short);
  });

  it.each([['development'], ['test']])('NODE_ENV=%j explains and calls the devtools hook', (value) => {
    const seen = observe(value);
    expect(seen.development).toBe(true);
    expect(seen.c1).toMatch(/^\[marmeon:C1\] Route \[people\.show\]: the browser has no route manifest/);
    expect(seen.c2).toMatch(/^\[marmeon:C2\] Route \[people\.show\] is not defined in the browser/);
    expect(seen.c5).toBe('[marmeon:C5] A poll needs an interval above 0 and up to 2147483647 ms, got 0.');
    expect(seen.hook).toBe(1);
  });
});
