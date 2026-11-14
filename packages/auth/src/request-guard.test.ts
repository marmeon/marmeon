import { describe, expect, it } from 'vitest';
import { Container } from '@marmeon/core';
import { Gate } from './gate.ts';
import { bindRequestGuard, markNamingMiddleware, newRequestGuard, RequestGuard, routeGuardOf, withRequestGuard } from './request-guard.ts';

describe('making a RequestGuard', () => {
  it('is not something the container builds by itself: a scope without the binding refuses', () => {
    expect(() => new Container().createScope().make(RequestGuard)).toThrow(/RequestGuard is made by the container binding/);
    expect(() => new RequestGuard()).toThrow(/RequestGuard is made by the container binding/);
  });

  it('is one per scope once bound, and a fresh one for the next scope', () => {
    const container = new Container();
    bindRequestGuard(container);
    const one = container.createScope();
    expect(one.make(RequestGuard)).toBe(one.make(RequestGuard));
    expect(container.createScope().make(RequestGuard)).not.toBe(one.make(RequestGuard));
  });
});

describe('a gate and a middleware without the binding', () => {
  it('refuse instead of passing with an empty stamp', async () => {
    const gate = new Gate({ user: async () => ({ id: 1 }) } as never, (Class) => new (Class as new () => never)());
    class Policy {
      view() {
        return true;
      }
    }
    await expect(gate.allows(Policy, 'view')).rejects.toThrow(/RequestGuard/);
    await expect(Promise.resolve(gate.abilities(Policy, ['view']))).rejects.toThrow(/RequestGuard/);
    // With a resolver that has it, the same gate answers.
    expect(await new Gate({ user: async () => ({ id: 1 }) } as never, withRequestGuard((Class) => new (Class as new () => never)())).allows(Policy, 'view')).toBe(true);
  });
});

describe('the guard of a request', () => {
  it('is nobody\'s until a middleware names one', () => {
    expect(newRequestGuard().name).toBeUndefined();
  });

  it('lets the app\'s session guard and token guard follow each other', () => {
    const request = newRequestGuard();
    request.claim('web', 'authenticate()');
    request.claim('api', "authenticate('api')");
    expect(request.name).toBe('api');
  });

  it.each([
    ['a package guard after the app', 'web', 'office'],
    ['the app after a package guard', 'office', 'web'],
    ['the token guard after a package guard', 'office', 'api'],
    ['a package guard after another', 'office', 'shop'],
  ])('refuses %s with A9, naming both guards', (_what, first, second) => {
    const request = newRequestGuard();
    request.claim(first, 'authenticate()');
    expect(() => request.claim(second, 'authenticate()')).toThrow(new RegExp(`A9.*'${second}'.*'${first}'`));
    expect(request.name, 'the first stays').toBe(first);
  });

  it('takes the same guard twice', () => {
    const request = newRequestGuard();
    request.claim('office', 'guest()');
    expect(() => request.claim('office', 'authenticate()')).not.toThrow();
  });

  it('makes the app\'s middleware refuse a package guard\'s route with A9, and takes the route for the app\'s when nobody has named one', () => {
    const owned = newRequestGuard();
    owned.claim('office', 'authenticate()');
    expect(() => owned.requireApp('twoFactor()')).toThrow(/A9.*twoFactor\(\).*'office'/);

    const open = newRequestGuard();
    open.requireApp('confirmedPassword()');
    expect(open.name).toBe('web');
    expect(() => open.claim('office', 'authenticate()'), 'a package guard cannot join a route the app\'s middleware has used').toThrow(/A9/);

    const token = newRequestGuard();
    token.claim('api', "authenticate('api')");
    token.requireApp('verified()');
    expect(token.name).toBe('api');
  });

  it('makes a package guard\'s middleware refuse another guard\'s route, and a route that no guard has claimed, with A9', () => {
    const own = newRequestGuard();
    own.claim('office', 'authenticate()');
    expect(() => own.requireGuard('office', 'confirmedPassword()')).not.toThrow();

    const app = newRequestGuard();
    app.claim('web', 'authenticate()');
    expect(() => app.requireGuard('office', 'confirmedPassword()')).toThrow(/A9.*'office'.*'web'/);

    const other = newRequestGuard();
    other.claim('shop', 'authenticate()');
    expect(() => other.requireGuard('office', 'confirmedPassword()')).toThrow(/A9.*'office'.*'shop'/);

    expect(() => newRequestGuard().requireGuard('office', 'confirmedPassword()')).toThrow(/A9.*authenticate\(\)/);
  });

  it('admits a policy of the route\'s guard only: the app\'s two guards are one circle, a package guard another', () => {
    for (const [stamp, policy, admitted] of [
      ['office', 'web', false],
      ['office', 'shop', false],
      ['office', 'office', true],
      ['web', 'office', false],
      ['api', 'office', false],
      ['web', 'web', true],
      ['api', 'web', true],
    ] as const) {
      const request = newRequestGuard();
      request.claim(stamp, 'authenticate()');
      expect(request.admit(policy), `${policy} on ${stamp}`).toBe(admitted);
    }
  });

  it('admits every policy on a route no middleware named, and then refuses a middleware of an incompatible guard (A9)', () => {
    const request = newRequestGuard();
    expect(request.admit('web')).toBe(true);
    expect(request.name, 'a decision does not stamp').toBeUndefined();
    expect(() => request.claim('office', 'authenticate()')).toThrow(/A9.*'office'.*policy of 'web'/);
    expect(() => request.claim('api', "authenticate('api')")).not.toThrow();
    const guest = newRequestGuard();
    guest.admit('web');
    expect(() => guest.claim('office', 'guest()')).toThrow(/A9/);
    expect(() => newRequestGuard().claim('office', 'guest()')).not.toThrow();
  });

  it('stamps once, and again as the same guard, but never as another', () => {
    const request = newRequestGuard();
    request.stamp('office');
    expect(() => request.stamp('office')).not.toThrow();
    expect(() => request.stamp('web')).toThrow(/A9/);
    expect(request.name).toBe('office');
  });
});

describe('the guard a route\'s middleware list names', () => {
  const naming = (guard: string, name: string) => {
    const Named = class {};
    Object.defineProperty(Named, 'name', { value: name });
    markNamingMiddleware(Named, () => guard);
    return Named;
  };

  it('is the first naming middleware\'s, by class identity: a look-alike by name or shape names nothing', () => {
    const office = naming('office', 'authenticate:office');
    const lookAlike = Object.defineProperty(class {}, 'name', { value: 'authenticate:office' });
    expect(routeGuardOf([lookAlike, class {}])).toBeUndefined();
    expect(routeGuardOf([class {}, office])).toEqual({ guard: 'office' });
  });

  it('takes web and api together and the same guard twice, and reports any other pair as a conflict naming both', () => {
    expect(routeGuardOf([naming('api', 'a'), naming('web', 'b')])).toEqual({ guard: 'api' });
    expect(routeGuardOf([naming('office', 'a'), naming('office', 'b')])).toEqual({ guard: 'office' });
    for (const pair of [['web', 'office'], ['office', 'web'], ['api', 'office'], ['office', 'shop']] as const) {
      expect(routeGuardOf([naming(pair[0], 'first'), naming(pair[1], 'second')]), pair.join()).toEqual({
        conflict: `first acts for the guard '${pair[0]}' and second for '${pair[1]}': a route belongs to one guard.`,
      });
    }
  });

  it('is worked out once per list', () => {
    let reads = 0;
    const Named = class {};
    markNamingMiddleware(Named, () => (reads++, 'office'));
    const list = Object.freeze([Named]);
    routeGuardOf(list);
    routeGuardOf(list);
    expect(reads).toBe(1);
  });
});
