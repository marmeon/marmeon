import { describe, expect, it } from 'vitest';
import { createApplication, type Application } from './application.ts';
import type { ServiceProvider } from './provider.ts';

function recorder() {
  const calls: string[] = [];
  const provider = (name: string, fail = false) =>
    class implements ServiceProvider {
      boot(): void {
        calls.push(`boot ${name}`);
      }
      shutdown(app: Application): void {
        calls.push(`shutdown ${name}${app ? '' : ' (no app)'}`);
        if (fail) throw new Error(`${name} failed`);
      }
    };
  return { calls, provider };
}

describe('Application.shutdown', () => {
  it('shuts providers down in reverse boot order, once', async () => {
    const { calls, provider } = recorder();
    const app = await createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [provider('a'), provider('b')] });
    await Promise.all([app.shutdown(), app.shutdown()]);
    await app.shutdown();
    expect(calls).toEqual(['boot a', 'boot b', 'shutdown b', 'shutdown a']);
  });

  it('gives every provider its turn and reports all failures', async () => {
    const { calls, provider } = recorder();
    const app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      env: {},
      providers: [provider('a', true), provider('b'), provider('c', true)],
    });
    const error = await app.shutdown().then(() => undefined, (e: unknown) => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors.map((e: Error) => e.message)).toEqual(['c failed', 'a failed']);
    expect(calls.filter((c) => c.startsWith('shutdown'))).toEqual(['shutdown c', 'shutdown b', 'shutdown a']);
  });

  it('works with `await using`', async () => {
    const { calls, provider } = recorder();
    {
      await using _app = await createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [provider('a')] });
    }
    expect(calls).toEqual(['boot a', 'shutdown a']);
  });

  it('accepts a provider that only shuts down', async () => {
    const OnlyShutdown = class implements ServiceProvider {
      shutdown(): void {}
    };
    await expect(createApplication({ root: import.meta.dirname, discover: false, env: {}, providers: [OnlyShutdown] })).resolves.toBeDefined();
  });
});
