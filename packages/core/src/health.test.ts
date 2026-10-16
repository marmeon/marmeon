import { describe, expect, it } from 'vitest';
import { createApplication } from './application.ts';
import { Container } from './container.ts';
import { HealthChecks, type HealthCheck } from './health.ts';
import { defineModule } from './module.ts';
import { token } from './token.ts';

interface Pinger {
  ping(): Promise<void>;
}
const Pinger = token<Pinger>('Pinger');

class PingCheck implements HealthCheck {
  static check = 'ping';
  readonly #pinger: Pinger;
  constructor(pinger: Pinger) {
    this.#pinger = pinger;
  }
  async handle(): Promise<string> {
    await this.#pinger.ping();
    return 'pong';
  }
}
class FailingCheck implements HealthCheck {
  static check = 'disk';
  handle(): void {
    throw new Error('the disk is full');
  }
}
class SlowCheck implements HealthCheck {
  static check = 'slow';
  static timeout = 20;
  handle(): Promise<void> {
    // Rejects long after its time ran out: never an unhandled rejection.
    return new Promise((_, reject) => setTimeout(() => reject(new Error('too late')), 100));
  }
}

describe('HealthChecks', () => {
  it('runs every check at once: ok with notes, failing with the error, a timeout after its time', async () => {
    const container = new Container();
    container.instance(Pinger, { ping: async () => {} });
    const report = await new HealthChecks([PingCheck, FailingCheck, SlowCheck]).run(container);
    expect(report.ok).toBe(false);
    expect(report.checks.map(({ name, status, note }) => ({ name, status, note }))).toEqual([
      { name: 'ping', status: 'ok', note: 'pong' },
      { name: 'disk', status: 'failing', note: undefined },
      { name: 'slow', status: 'timeout', note: undefined },
    ]);
    expect((report.checks[1]!.error as Error).message).toBe('the disk is full');
    expect(report.checks[2]!.ms).toBe(20);
    // The late rejection of the slow check must not surface (Vitest fails the run on an unhandled rejection).
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

  it('the default time limit is 2 s — a check that hangs does not hold up the others', async () => {
    const container = new Container();
    container.instance(Pinger, { ping: () => new Promise(() => {}) });
    const started = performance.now();
    const report = await new HealthChecks([PingCheck]).run(container, { timeout: 50 });
    expect(report.checks[0]).toMatchObject({ name: 'ping', status: 'timeout', ms: 50 });
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it('every check is built anew in a scope of its own (constructor injection)', async () => {
    const container = new Container();
    let pings = 0;
    container.instance(Pinger, { ping: async () => void pings++ });
    const checks = new HealthChecks([PingCheck]);
    await checks.run(container);
    await checks.run(container);
    expect(pings).toBe(2);
  });

  it('names are unique and required', () => {
    class OtherPing {
      static check = 'ping';
      handle() {}
    }
    class Nameless {
      handle() {}
    }
    expect(() => new HealthChecks([PingCheck, OtherPing])).toThrow('Two health checks are named "ping": PingCheck and OtherPing.');
    expect(() => new HealthChecks([Nameless as never])).toThrow('Nameless is listed as a health check but has no `static check');
    expect(new HealthChecks([PingCheck, PingCheck]).all()).toEqual([PingCheck]);
  });

  it('createApplication collects them: providers\' `static health`, then the app\'s, then each module\'s', async () => {
    class DatabaseProvider {
      static health = [FailingCheck];
    }
    const app = await createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [DatabaseProvider],
      health: [PingCheck],
      modules: [defineModule({ name: 'storage', health: [SlowCheck] })],
    }, { env: {} });
    expect(app.container.make(HealthChecks).all()).toEqual([FailingCheck, PingCheck, SlowCheck]);
  });

  it('the contract is typed: `static check` and `handle()`', () => {
    class NoName {
      handle() {}
    }
    class NoHandle {
      static check = 'x';
    }
    class WrongReturn {
      static check = 'x';
      handle(): number {
        return 1;
      }
    }
    // Checked by the compiler only — never run.
    const typeOnly = () => {
      // @ts-expect-error — Property 'check' is missing in type 'typeof NoName'.
      defineModule({ name: 'a', health: [NoName] });
      // @ts-expect-error — Property 'handle' is missing in type 'NoHandle'.
      defineModule({ name: 'b', health: [NoHandle] });
      // @ts-expect-error — The types returned by 'handle()' are incompatible.
      defineModule({ name: 'c', health: [WrongReturn] });
      defineModule({ name: 'd', health: [PingCheck, FailingCheck] });
    };
    expect(typeOnly).toBeTypeOf('function');
  });
});
