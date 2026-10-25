import { describe, expect, it, vi } from 'vitest';
import type { Duration } from './clock.ts';
import { createApplication } from './application.ts';
import { Container } from './container.ts';
import { HealthChecks, type HealthCheck, type HealthReport } from './health.ts';
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
  static timeout = { milliseconds: 20 };
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
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const container = new Container();
      container.instance(Pinger, { ping: () => new Promise(() => {}) });
      let report: HealthReport | undefined;
      const running = new HealthChecks([PingCheck]).run(container).then((result) => (report = result));
      await vi.advanceTimersByTimeAsync(1_999);
      expect(report).toBeUndefined(); // still inside its time
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(report!.checks[0]).toMatchObject({ name: 'ping', status: 'timeout', ms: 2_000 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes static timeout and run({ timeout }) as seconds or parts', async () => {
    class Seconds implements HealthCheck {
      static check = 'seconds';
      static timeout = 0.05;
      handle = () => new Promise<void>(() => {});
    }
    class Parts implements HealthCheck {
      static check = 'parts';
      static timeout = { milliseconds: 500 };
      handle(): void {}
    }
    class Default implements HealthCheck {
      static check = 'default';
      handle = () => new Promise<void>(() => {});
    }
    const report = await new HealthChecks([Seconds, Parts, Default]).run(new Container(), { timeout: { milliseconds: 30 } });
    expect(report.checks.map(({ name, status, ms }) => ({ name, status, ms: status === 'timeout' ? ms : 0 }))).toEqual([
      { name: 'seconds', status: 'timeout', ms: 50 },
      { name: 'parts', status: 'ok', ms: 0 },
      { name: 'default', status: 'timeout', ms: 30 },
    ]);
  });

  it('refuses a static timeout over a minute, which only a value meant as milliseconds can be (K13)', () => {
    class Old implements HealthCheck {
      static check = 'old';
      static timeout = 5000;
      handle(): void {}
    }
    expect(() => new HealthChecks([Old])).toThrow(/\[marmeon:K13\].*static timeout.*is in seconds — for 5000 ms write `\{ milliseconds: 5000 \}`/);
    class Longest implements HealthCheck {
      static check = 'longest';
      static timeout = { minutes: 1 };
      handle(): void {}
    }
    expect(new HealthChecks([Longest]).all()).toHaveLength(1);
    class Text implements HealthCheck {
      static check = 'text';
      // @ts-expect-error a string is no span of time
      static timeout: Duration = '2s';
      handle(): void {}
    }
    expect(() => new HealthChecks([Text])).toThrow(/Text has a `static timeout` that is no span of time/);
    class Zero implements HealthCheck {
      static check = 'zero';
      static timeout = 0;
      handle(): void {}
    }
    expect(() => new HealthChecks([Zero])).toThrow(/\[marmeon:K13\].*above zero/);
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
