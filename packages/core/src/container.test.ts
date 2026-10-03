import { describe, expect, it } from 'vitest';
import { Container, ContainerError, token } from './index.ts';

interface Mailer {
  send(to: string): string;
}
const Mailer = token<Mailer>('Mailer');

interface Clock {
  now(): string;
}
const Clock = token<Clock>('Clock');

class FixedClock implements Clock {
  now() {
    return '09:00';
  }
}

class SmtpMailer implements Mailer {
  static inject = [Clock] as const;
  readonly #clock: Clock;
  constructor(clock: Clock) {
    this.#clock = clock;
  }
  send(to: string) {
    return `smtp → ${to} @ ${this.#clock.now()}`;
  }
}

class WelcomeService {
  static inject = [Mailer] as const;
  readonly mailer: Mailer;
  constructor(mailer: Mailer) {
    this.mailer = mailer;
  }
}

// Top-level on purpose: the injection transform (Vitest plugin) attaches why it cannot be injected.
class Money {
  constructor(_amount: number) {}
}

class Counter {
  static created = 0;
  readonly id = ++Counter.created;
}

describe('Container — bindings', () => {
  it('binds interfaces to implementations through tokens', () => {
    const container = new Container().bind(Clock, FixedClock).bind(Mailer, SmtpMailer);
    expect(container.make(WelcomeService).mailer.send('ada@example.com')).toBe('smtp → ada@example.com @ 09:00');
  });

  it('autowires unbound classes', () => {
    class NoDeps {}
    expect(new Container().make(NoDeps)).toBeInstanceOf(NoDeps);
  });

  it('builds transient bindings on every resolution', () => {
    const container = new Container().bind(Counter, Counter);
    expect(container.make(Counter)).not.toBe(container.make(Counter));
  });

  it('shares singletons', () => {
    const container = new Container().singleton(Counter);
    expect(container.make(Counter)).toBe(container.make(Counter));
  });

  it('resolves factories with access to the container', () => {
    const container = new Container().bind(Clock, FixedClock).singleton(Mailer, (c) => new SmtpMailer(c.make(Clock)));
    expect(container.make(Mailer).send('x')).toBe('smtp → x @ 09:00');
  });

  it('returns registered instances', () => {
    const clock = new FixedClock();
    expect(new Container().instance(Clock, clock).make(Clock)).toBe(clock);
  });

  it('replaces a cached singleton when re-bound', () => {
    const container = new Container().singleton(Clock, FixedClock);
    const first = container.make(Clock);
    container.singleton(Clock, FixedClock);
    expect(container.make(Clock)).not.toBe(first);
  });
});

describe('Container — scopes', () => {
  it('shares scoped instances within a scope, not across scopes', () => {
    const root = new Container().scoped(Counter);
    const a = root.createScope();
    const b = root.createScope();
    expect(a.make(Counter)).toBe(a.make(Counter));
    expect(a.make(Counter)).not.toBe(b.make(Counter));
  });

  it('refuses to resolve scoped bindings outside a scope', () => {
    const root = new Container().scoped(Counter);
    expect(() => root.make(Counter)).toThrow(/scoped and can only be resolved inside a scope/);
  });

  it('prevents singletons from capturing scoped services', () => {
    class RequestInfo {}
    class Cache {
      static inject = [RequestInfo] as const;
      constructor(_info: RequestInfo) {}
    }
    const root = new Container().scoped(RequestInfo).singleton(Cache);
    expect(() => root.createScope().make(Cache)).toThrow(/needed by Cache\)\. A singleton must not depend on a scoped service/);
  });

  it('sees scope-local instances, while the root does not', () => {
    const Request = token<{ url: string }>('Request');
    class Handler {
      static inject = [Request] as const;
      readonly url: string;
      constructor(request: { url: string }) {
        this.url = request.url;
      }
    }
    const root = new Container();
    const scope = root.createScope().instance(Request, { url: '/users/1' });

    expect(scope.make(Handler).url).toBe('/users/1');
    expect(() => root.make(Handler)).toThrow(/No binding for \[Request\] \(needed by Handler\)/);
  });

  it('builds singletons once, even when first requested from a scope', () => {
    const root = new Container().singleton(Counter);
    expect(root.createScope().make(Counter)).toBe(root.createScope().make(Counter));
  });
});

describe('Container — errors', () => {
  it('names the dependency chain for missing bindings', () => {
    expect(() => new Container().bind(Clock, FixedClock).make(WelcomeService)).toThrow(
      'No binding for [Mailer] (needed by WelcomeService). Bind it in a service provider.',
    );
  });

  it('detects circular dependencies', () => {
    class A {
      static inject: unknown[] = [];
      constructor(_b: unknown) {}
    }
    class B {
      static inject = [A] as const;
      constructor(_a: A) {}
    }
    A.inject = [B];
    expect(() => new Container().make(A)).toThrow('Circular dependency: A → B → A.');
  });

  it('reports why the injection transform could not derive a list', () => {
    expect(() => new Container().make(Money)).toThrow(
      /\[Money\] needs 1 constructor argument\(s\) but has no injection list\. Cannot inject .*container\.test\.ts:\d+ — Money, parameter "_amount: number": only classes and tokens can be injected, not "number"/,
    );
  });

  it('explains classes that have constructor parameters but no injection list', () => {
    // Created at runtime, so the injection transform never sees it (like code outside the loader's reach).
    const Needy = new Function('return class Needy { constructor(clock) {} }')() as new (clock: Clock) => object;
    expect(() => new Container().make(Needy)).toThrow(ContainerError);
    expect(() => new Container().make(Needy)).toThrow(/\[Needy\] needs 1 constructor argument\(s\) but has no injection list/);
  });
});

describe('Container — what its errors say about themselves (E130)', () => {
  it('names the reason, the key and who asked for it', () => {
    const unbound = catching(() => new Container().bind(Clock, FixedClock).make(WelcomeService));
    expect(unbound).toMatchObject({ reason: 'unbound', key: 'Mailer', path: ['WelcomeService'], neededBy: 'WelcomeService' });

    class Scoped {}
    const scoped = catching(() => new Container().scoped(Scoped).make(Scoped));
    expect(scoped).toMatchObject({ reason: 'scoped', key: 'Scoped', path: [], neededBy: undefined });

    const listless = catching(() => new Container().make(Money));
    expect(listless).toMatchObject({ reason: 'no-injection-list', key: 'Money' });
    expect(listless.injection).toMatch(/only classes and tokens can be injected, not "number"/);

    class A {
      static inject: unknown[] = [];
      constructor(_b: unknown) {}
    }
    class B {
      static inject = [A] as const;
      constructor(_a: A) {}
    }
    A.inject = [B];
    expect(catching(() => new Container().make(A))).toMatchObject({ reason: 'circular', key: 'A', path: ['A', 'B'] });
  });
});

// The W6.6 case (E128): a defaulted parameter is never injected — the transform marks the class, the container says so.
class WallClock {
  now() {
    return 'wall';
  }
}
class FakeWallClock extends WallClock {
  override now() {
    return 'fake';
  }
}
class Reminder {
  readonly clock: WallClock;
  constructor(clock: WallClock = new WallClock()) {
    this.clock = clock;
  }
}

describe('Container — injection warnings (E128)', () => {
  it('builds the class with its default, and reports the warning once per class — no error', () => {
    const container = new Container().instance(WallClock, new FakeWallClock());
    const heard: string[] = [];
    const off = container.onWarning((warning) => heard.push(`${warning.className}: ${warning.message}`));

    // The default wins over the binding: what the warning is about.
    expect(container.make(Reminder).clock.now()).toBe('wall');
    container.createScope().make(Reminder);
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatch(/^Reminder: Reminder \(.*container\.test\.ts:\d+\): the parameter "clock: WallClock = new WallClock\(\)" is defaulted, so the container never injects WallClock/);
    expect(container.warnings.map((warning) => warning.className)).toEqual(['Reminder']);

    off();
    expect(new Container().make(WallClock)).toBeInstanceOf(WallClock); // no warning for a class without one
  });
});

function catching(fn: () => unknown): ContainerError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ContainerError) return error;
    throw error;
  }
  throw new Error('expected a ContainerError');
}

// ---------------------------------------------------------------------------
// Type-level guarantees — checked by `tsc`, not at runtime.
// ---------------------------------------------------------------------------

// Never called: the calls below would throw at runtime, only their types matter.
export function typeLevelTests(): void {
  const container = new Container();

  class NotAMailer {
    post() {}
  }
  // @ts-expect-error — NotAMailer does not implement Mailer.
  container.bind(Mailer, NotAMailer);

  // @ts-expect-error — the factory returns a Clock, not a Mailer.
  container.bind(Mailer, () => new FixedClock());

  class MissingDependency {
    static inject = [] as const;
    constructor(_clock: Clock) {}
  }
  // @ts-expect-error — `inject` forgot the Clock.
  container.singleton(MissingDependency);

  class Logger {
    log(_m: string) {}
  }
  class FileLogger extends Logger {
    path = '/tmp/app.log';
  }
  class SwappedRelated {
    static inject = [FileLogger, Logger] as const;
    constructor(_logger: Logger, _file: FileLogger) {}
  }
  // @ts-expect-error — swapped *related* dependencies are caught too (tuple check, not bivariant).
  container.make(SwappedRelated);

  // @ts-expect-error — resolving a Clock token never yields a Mailer.
  const wrong: Mailer = container.make(Clock);
  void wrong;

  // A token cannot bind itself — it needs an implementation:
  // @ts-expect-error — no concrete given for an interface token.
  container.singleton(Clock);
}
