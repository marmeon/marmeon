import { EventDispatcher, EventRegistry, type QueueableEvent } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import * as appEvents from './events.ts';
import { guardEvents } from './guard-events.ts';
import { defineGuard } from './define-guard.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const user = { id: 7, email: 'ada@example.com' } as never;

/** One instance of each class a guard's services dispatch, made as they make it. */
const INSTANCES: Record<string, () => object> = {
  SignedIn: () => new appEvents.SignedIn(user, { remember: true, via: 'attempt', ip: '203.0.113.9', userAgent: 'Test' }, new Date('2030-01-02T03:04:05.000Z')),
  SignedOut: () => new appEvents.SignedOut(user),
  SignInFailed: () => new appEvents.SignInFailed('ada@example.com', user),
  SignInLockedOut: () => new appEvents.SignInLockedOut('ada@example.com', '203.0.113.9', 'client'),
  PasswordChanged: () => new appEvents.PasswordChanged(user, 2),
  PasswordReset: () => new appEvents.PasswordReset(user, 1),
  RememberTokenReused: () => new appEvents.RememberTokenReused(user, { ip: '203.0.113.9', userAgent: 'Test', sessionsEnded: true }, new Date('2030-01-02T03:04:05.000Z')),
  TwoFactorEnabled: () => new appEvents.TwoFactorEnabled(user, 'passkey'),
  TwoFactorDisabled: () => new appEvents.TwoFactorDisabled(user, 'operator'),
  RecoveryCodesGenerated: () => new appEvents.RecoveryCodesGenerated(user),
  RecoveryCodeUsed: () => new appEvents.RecoveryCodeUsed(user, 3),
  TwoFactorChallengeFailed: () => new appEvents.TwoFactorChallengeFailed(user, { during: 'confirm' }, new Date('2030-01-02T03:04:05.000Z')),
  PasskeyRegistered: () => new appEvents.PasskeyRegistered(user, 'Laptop'),
  PasskeyRemoved: () => new appEvents.PasskeyRemoved(user, 'reset'),
  PasskeyCloneSuspected: () => new appEvents.PasskeyCloneSuspected(user, 5),
  PasskeySignInFailed: () => new appEvents.PasskeySignInFailed(user, { ip: '203.0.113.9' }, new Date('2030-01-02T03:04:05.000Z')),
};

// What `@marmeon/auth` exports as an event class, but that no guard's service dispatches: the app's own code raises the first, a guard has no email change, and none ends every session of every account.
const NOT_DISPATCHED_BY_A_GUARD = ['Registered', 'EmailChanged', 'EverySessionEnded'];

const eventClasses = Object.entries(appEvents).filter(([, value]) => typeof value === 'function' && /^[A-Z]/.test(value.name) && (value.prototype as object | undefined) !== undefined && !value.name.includes('Schema'));

const NAME = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;

async function heard(registry: EventRegistry, event: object): Promise<void> {
  await new EventDispatcher(registry, { make: () => undefined } as never).dispatch(event);
}

describe('a guard\'s events', () => {
  const { events, map } = guardEvents('office');

  it('has a class for every event class of the package that a guard dispatches, and for no other', () => {
    const expected = eventClasses.map(([key]) => key).filter((key) => !NOT_DISPATCHED_BY_A_GUARD.includes(key)).sort();
    expect(Object.keys(events).sort()).toEqual(expected);
    expect(Object.keys(INSTANCES).sort()).toEqual(expected);
  });

  it.each(Object.keys(INSTANCES))('%s: a listener of the app\'s class hears nothing of the guard, and one of the guard\'s class hears it once', async (key) => {
    const base = INSTANCES[key]!();
    const mapped = map(base)!;
    expect(mapped).toBeDefined();
    expect(mapped).not.toBe(base);
    expect(mapped).toBeInstanceOf((events as unknown as Record<string, new () => object>)[key]!);
    expect(mapped).not.toBeInstanceOf(base.constructor as never);

    const registry = new EventRegistry();
    const app: object[] = [];
    const own: object[] = [];
    registry.listen(base.constructor as never, ((event: object) => void app.push(event)) as never);
    registry.listen((events as unknown as Record<string, never>)[key]!, ((event: object) => void own.push(event)) as never);
    await heard(registry, mapped);
    expect(app).toEqual([]);
    expect(own).toEqual([mapped]);
    // The same fields as the app's event, so a listener reads them the same way.
    expect({ ...mapped }).toEqual({ ...base });
  });

  it('keeps the getters of the app\'s class', () => {
    const mapped = map(INSTANCES.SignedIn!()) as { userId: number };
    expect(mapped.userId).toBe(7);
  });

  it('names each queueable event office.auth.<name>, with the schema of the app\'s event, and each name once', () => {
    const names: string[] = [];
    for (const key of Object.keys(events)) {
      const own = (events as unknown as Record<string, Partial<QueueableEvent>>)[key]!;
      const base = (appEvents as unknown as Record<string, Partial<QueueableEvent>>)[key]!;
      expect(own.event, key).toBe(base.event === undefined ? undefined : `office.${base.event}`);
      expect(own.schema === undefined, key).toBe(base.schema === undefined);
      if (own.event !== undefined) {
        expect(own.event).toMatch(NAME);
        names.push(own.event);
      }
    }
    expect(names).toContain('office.auth.signed-in');
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives a queued listener the payload of the app\'s event', async () => {
    const { SignedIn } = events;
    const validated = await SignedIn.schema['~standard'].validate(map(INSTANCES.SignedIn!()));
    expect(validated).toEqual({ typed: true, value: { userId: 7, remember: true, via: 'attempt', at: '2030-01-02T03:04:05.000Z', ip: '203.0.113.9', userAgent: 'Test', guard: 'office' } });
    // The app's payload has no `guard`, so a queued listener of the app's class and one of the guard's never read the same JSON.
    expect(await appEvents.SignedIn.schema['~standard'].validate(INSTANCES.SignedIn!())).toEqual({ typed: true, value: { userId: 7, remember: true, via: 'attempt', at: '2030-01-02T03:04:05.000Z', ip: '203.0.113.9', userAgent: 'Test' } });
    // A payload that was queued carries `guard` already; another guard's name in it does not change the guard it is read for.
    expect(await SignedIn.schema['~standard'].validate({ userId: 7, remember: false, via: 'app', at: '2030-01-02T03:04:05.000Z', ip: null, userAgent: null, guard: 'desk' })).toEqual({
      typed: true,
      value: { userId: 7, remember: false, via: 'app', at: '2030-01-02T03:04:05.000Z', ip: null, userAgent: null, guard: 'office' },
    });
    expect((await SignedIn.schema['~standard'].validate({ userId: 'x' })).issues).toBeDefined();
  });

  it('queues a string id of the guard\'s user as it is, and reads it back from the queued payload', async () => {
    const stringUser = { id: 'usr_01', email: 'ada@example.com' } as never;
    const mapped = map(new appEvents.TwoFactorEnabled(stringUser, 'totp'))!;
    const schema = events.TwoFactorEnabled.schema['~standard'];
    expect(await schema.validate(mapped)).toEqual({ typed: true, value: { userId: 'usr_01', factor: 'totp', guard: 'office' } });
    expect(await schema.validate({ userId: 'usr_01', factor: 'totp', guard: 'office' })).toEqual({ typed: true, value: { userId: 'usr_01', factor: 'totp', guard: 'office' } });
    expect((mapped as { userId: unknown }).userId).toBe('usr_01');
  });

  it('constructs like the app\'s class', () => {
    const made = new events.PasskeyRemoved(user, 'reset');
    expect({ ...made }).toEqual({ ...new appEvents.PasskeyRemoved(user, 'reset') });
    expect(made).not.toBeInstanceOf(appEvents.PasskeyRemoved);
  });

  it('drops an event of a class it has none of, and an event that only extends one of the app\'s', () => {
    expect(map(new appEvents.Registered(user))).toBeUndefined();
    expect(map({})).toBeUndefined();
    expect(map(new (class extends appEvents.SignedOut {})(user))).toBeUndefined();
    expect(map(Object.create(null) as object)).toBeUndefined();
  });

  it('gives two guards classes and names of their own, one of them with a hyphen', () => {
    const back = guardEvents('back-office');
    expect(back.events.SignedIn).not.toBe(events.SignedIn);
    expect(back.events.SignedIn.event).toBe('back-office.auth.signed-in');
    expect(back.events.SignedIn.event).toMatch(NAME);
    expect(events.SignedIn.event).toBe('office.auth.signed-in');
    const registry = new EventRegistry();
    const heardByOffice: object[] = [];
    registry.listen(events.SignedIn, ((event: object) => void heardByOffice.push(event)) as never);
    return heard(registry, back.map(INSTANCES.SignedIn!())!).then(() => expect(heardByOffice).toEqual([]));
  });

  it('is the guard definition\'s events, one set per guard', () => {
    class Users extends MemoryUsers<{ id: number }> {}
    const Guard = defineGuard('office', { users: Users, tablePrefix: 'office_' });
    const Other = defineGuard('desk', { users: Users, tablePrefix: 'desk_' });
    expect(Guard.events.SignedIn.event).toBe('office.auth.signed-in');
    expect(Other.events.SignedIn.event).toBe('desk.auth.signed-in');
    expect(Guard.events.SignedIn).not.toBe(Other.events.SignedIn);
    expect(Guard.events.SignedIn).toBe(Guard.events.SignedIn);
  });

  it.each(Object.keys(INSTANCES))('%s: is named with the guard, never as the app\'s class', (key) => {
    const own = (events as unknown as Record<string, { name: string }>)[key]!;
    expect(own.name).toBe(`office:${key}`);
    expect(guardEvents('desk').events[key as keyof typeof events].name).toBe(`desk:${key}`);
    expect((map(INSTANCES[key]!()) as object).constructor.name).toBe(`office:${key}`);
  });

  it('is frozen: a class of the set cannot be replaced, nor a static of a class changed', () => {
    'use strict';
    expect(Object.isFrozen(events)).toBe(true);
    expect(() => {
      (events as unknown as Record<string, unknown>).SignedIn = class {};
    }).toThrow(TypeError);
    expect(() => {
      (events.SignedIn as unknown as { event: string }).event = 'auth.signed-in';
    }).toThrow(TypeError);
    expect(events.SignedIn.event).toBe('office.auth.signed-in');
  });
});
