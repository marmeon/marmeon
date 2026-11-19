import { Application, defineModule, type ApplicationDefinition, type Container, type ServiceProvider } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { Controller, HttpServiceProvider } from '@marmeon/http';
import { ServerServing } from '@marmeon/http/internal';
import type { PageRenderer } from '@marmeon/server/internal';
import { Scheduler, SchedulerServiceProvider } from '@marmeon/scheduler';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../scripts/test/temp-dir.js';
import { createTestApp } from './index.ts';
import { openRoutes } from './test-helpers/open-routes.ts';

// What createTestApp has started when something after the boot throws: the app (its providers' shutdown), what the serving
// callbacks ran, and the SSR server. The throws are injected where the code between `ServerServing.begin()` and the database
// block calls out: the recorder import, the kernel, the Scheduler of the app.
const state = vi.hoisted(() => ({
  loads: {} as Record<string, number>,
  broken: new Set<string>(),
  vitesStarted: 0,
  vitesClosed: 0,
  failRecorderImport: false,
  failKernel: false,
  failViteStart: false,
  failViteClose: false,
  failRecorderClose: false,
  recordersMade: 0,
  recordersClosed: 0,
}));

// The loaders of the optional peers: every call counted, one of them failing like a broken install.
vi.mock('./optional-peer.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('./optional-peer.ts')>();
  return {
    ...original,
    importOptional: (name: string, ...rest: [never, never?]) => {
      state.loads[name] = (state.loads[name] ?? 0) + 1;
      if (state.broken.has(name)) return Promise.reject(new Error(`${name} is broken`));
      return original.importOptional(name, ...(rest as Parameters<typeof original.importOptional> extends [string, ...infer R] ? R : never));
    },
  };
});
vi.mock('@marmeon/server/internal', async (importOriginal) => {
  const original = await importOriginal<typeof import('@marmeon/server/internal')>();
  return {
    ...original,
    importRequestRecorder: async () => {
      if (state.failRecorderImport) throw new Error('recorder does not load');
      const module = await original.importRequestRecorder();
      return {
        ...module,
        createRequestRecorder: (app: Parameters<typeof module.createRequestRecorder>[0]) => {
          const recorder = module.createRequestRecorder(app);
          state.recordersMade++;
          const close = recorder.close.bind(recorder);
          recorder.close = () => {
            state.recordersClosed++;
            close();
            if (state.failRecorderClose) throw new Error('recorder close failed');
          };
          return recorder;
        },
      };
    },
    createViteDevRenderer: async () => {
      if (state.failViteStart) throw new Error('vite does not start');
      state.vitesStarted++;
      return {
        vite: {
          close: async () => {
            state.vitesClosed++;
            if (state.failViteClose) throw new Error('vite close failed');
          },
        },
        renderer: { render: async () => '<html></html>', shell: async () => '<html></html>' } as unknown as PageRenderer,
      };
    },
  };
});
vi.mock('@marmeon/server', async (importOriginal) => {
  const original = await importOriginal<typeof import('@marmeon/server')>();
  return {
    ...original,
    createHttpKernel: (...args: Parameters<typeof original.createHttpKernel>) => {
      if (state.failKernel) throw new Error('kernel refuses the app');
      return original.createHttpKernel(...args);
    },
  };
});

const probe = { served: 0, shutdowns: 0, schedulerFails: false, serveFails: false, shutdownFails: false };

class Probe implements ServiceProvider {
  boot(app: Application): void {
    app.container.make(ServerServing).onServe(() => {
      probe.served++;
      if (probe.serveFails) throw new Error('serving callback failed');
    });
    // After the scheduler's own boot has made it: the next `make` (createTestApp's) fails.
    if (probe.schedulerFails && app.container.has(Scheduler)) {
      (app.container as Container).singleton(Scheduler, () => {
        throw new Error('scheduler does not build');
      });
    }
  }
  shutdown(): void {
    probe.shutdowns++;
    if (probe.shutdownFails) throw new Error('probe shutdown failed');
  }
}

class HelloController extends Controller {
  handle() {
    return new Response('hello');
  }
}

const env = { APP_KEY: generateKey() };

function appAt(root: string, scheduler = false): ApplicationDefinition {
  return {
    root,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ...(scheduler ? [SchedulerServiceProvider] : []), Probe],
    modules: [defineModule({ name: 'pages', routes: openRoutes((Route) => Route.get('/hello', HelloController)) })],
  };
}

function reset(): void {
  state.loads = {};
  state.broken.clear();
  state.vitesStarted = 0;
  state.vitesClosed = 0;
  state.failRecorderImport = false;
  state.failKernel = false;
  state.failViteStart = false;
  state.failViteClose = false;
  state.failRecorderClose = false;
  state.recordersMade = 0;
  state.recordersClosed = 0;
  probe.serveFails = false;
  probe.shutdownFails = false;
  probe.served = 0;
  probe.shutdowns = 0;
  probe.schedulerFails = false;
}

beforeEach(reset);

describe('a broken @marmeon/auth', () => {
  it('fails createTestApp before the boot, with nothing left running', async () => {
    state.broken.add('@marmeon/auth');
    await expect(createTestApp(appAt(tempDir('marmeon-boot-guards-')), { env })).rejects.toThrow('@marmeon/auth is broken');
    expect(probe.served).toBe(0);
    expect(probe.shutdowns).toBe(0);
  });

  it('is loaded once per app, not per request or actingAs', async () => {
    const app = await createTestApp(appAt(tempDir('marmeon-boot-guards-')), { env });
    expect(state.loads['@marmeon/auth']).toBe(1);
    await app.get('/hello').assertOk();
    await app.get('/hello').assertOk();
    // The app has no user provider: actingAs() reaches @marmeon/auth and fails there, which is all this needs.
    await expect(app.actingAs({ id: 1, email: 'a@example.test' }).get('/hello')).rejects.toThrow('UserProvider');
    // The token path (guard 'api'): whatever it fails with, it does not load @marmeon/auth again.
    await app.actingAs({ id: 1, email: 'a@example.test' }, { guard: 'api' }).get('/hello').then(undefined, () => undefined);
    await app.get('/hello').assertOk();
    expect(state.loads['@marmeon/auth']).toBe(1);
    await app.close();
  });
});

describe('a failure between ServerServing.begin() and the database block', () => {
  async function expectClosed(definition: ApplicationDefinition, options: Parameters<typeof createTestApp>[1], message: string): Promise<void> {
    const closed = state.vitesClosed;
    const started = state.vitesStarted;
    await expect(createTestApp(definition, { env, ssr: true, ...options })).rejects.toThrow(message);
    expect(probe.served).toBe(1); // begin() ran: the failure came after it
    expect(probe.shutdowns).toBe(1);
    expect(state.vitesStarted).toBe(started + 1);
    expect(state.vitesClosed).toBe(closed + 1);
  }

  it('closes the app and the SSR server when the request recorder does not load', async () => {
    state.failRecorderImport = true;
    await expectClosed(appAt(tempDir('marmeon-boot-guards-')), { debug: true }, 'recorder does not load');
  });

  it('closes the app and the SSR server when the kernel refuses the app', async () => {
    state.failKernel = true;
    await expectClosed(appAt(tempDir('marmeon-boot-guards-')), {}, 'kernel refuses the app');
  });

  it('closes the app and the SSR server when the scheduler does not build', async () => {
    probe.schedulerFails = true;
    await expectClosed(appAt(tempDir('marmeon-boot-guards-'), true), {}, 'scheduler does not build');
  });

  it('keeps the original error when a close fails too', async () => {
    state.failKernel = true;
    const definition = appAt(tempDir('marmeon-boot-guards-'));
    class Failing implements ServiceProvider {
      shutdown(): never {
        throw new Error('shutdown failed');
      }
    }
    await expect(createTestApp({ ...definition, providers: [...(definition.providers ?? []), Failing] }, { env })).rejects.toThrow('kernel refuses the app');
  });
});

describe('the other ways a createTestApp fails after something started', () => {
  it('closes the recorder as well when the kernel refuses the app', async () => {
    state.failKernel = true;
    await expect(createTestApp(appAt(tempDir('marmeon-boot-guards-')), { env, debug: true })).rejects.toThrow('kernel refuses the app');
    expect(state.recordersMade).toBe(1);
    expect(state.recordersClosed).toBe(1);
    expect(probe.shutdowns).toBe(1);
  });

  it('shuts the app down and keeps the cause when the serving callback throws and the SSR server does not close', async () => {
    probe.serveFails = true;
    state.failViteClose = true;
    await expect(createTestApp(appAt(tempDir('marmeon-boot-guards-')), { env, ssr: true })).rejects.toThrow('serving callback failed');
    expect(state.vitesClosed).toBe(1);
    expect(probe.shutdowns).toBe(1);
  });

  it('keeps the cause when the SSR server does not start and a provider fails to shut down', async () => {
    state.failViteStart = true;
    probe.shutdownFails = true;
    await expect(createTestApp(appAt(tempDir('marmeon-boot-guards-')), { env, ssr: true })).rejects.toThrow('vite does not start');
    expect(probe.shutdowns).toBe(1);
  });

  it('shuts the app down and keeps the cause when the SSR server and the recorder do not close', async () => {
    state.failKernel = true;
    state.failViteClose = true;
    state.failRecorderClose = true;
    await expect(createTestApp(appAt(tempDir('marmeon-boot-guards-')), { env, ssr: true, debug: true })).rejects.toThrow('kernel refuses the app');
    expect(state.recordersClosed).toBe(1);
    expect(state.vitesClosed).toBe(1);
    expect(probe.shutdowns).toBe(1);
  });
});

describe('closing an app', () => {
  // Made in a hook, outside the test: an app made inside it closes itself when the test ends, and its failed close would fail the test again.
  let app: Awaited<ReturnType<typeof createTestApp>>;
  beforeAll(async () => {
    reset();
    app = await createTestApp(appAt(tempDir('marmeon-boot-guards-')), { env, ssr: true, debug: true });
  });
  // Closed by the test; this only catches a test that failed before it got there.
  afterAll(() => app.close().catch(() => undefined));

  it('runs every cleanup and shuts down when the SSR server and the recorder do not close, and rejects with the first failure', async () => {
    state.failViteClose = true;
    state.failRecorderClose = true;
    await expect(app.close()).rejects.toThrow('vite close failed');
    expect(state.recordersClosed).toBe(1);
    expect(probe.shutdowns).toBe(1);
  });
});

describe('a refused devtools option', () => {
  it('shuts the app down and says the app does not register the devtools', async () => {
    await expect(createTestApp(appAt(tempDir('marmeon-boot-guards-')), { env, devtools: true })).rejects.toThrow('does not register @marmeon/devtools');
    expect(probe.shutdowns).toBe(1);
  });
});
