import { Container, EventDispatcher, EventRegistry, type QueueableEvent } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import * as appEvents from './events.ts';
import { defineGuard, type Guard } from './define-guard.ts';
import { defineGuardSlot } from './guard-slot.ts';
import { guardEvents } from './guard-events.ts';
import { slotEventSet, slotEventsFor, slotOfEvent } from './slot-events.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const user = { id: 7, email: 'ada@example.com' } as never;
const NAME = /^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/;
const AT = new Date('2030-01-02T03:04:05.000Z');

/** One instance of each class a guard's services dispatch, made as they make it. */
const INSTANCES: Record<string, () => object> = {
  SignedIn: () => new appEvents.SignedIn(user, { remember: true, via: 'attempt', ip: '203.0.113.9', userAgent: 'Test' }, AT),
  SignedOut: () => new appEvents.SignedOut(user),
  SignInFailed: () => new appEvents.SignInFailed('ada@example.com', user),
  SignInLockedOut: () => new appEvents.SignInLockedOut('ada@example.com', '203.0.113.9', 'client'),
  PasswordChanged: () => new appEvents.PasswordChanged(user, 2),
  PasswordReset: () => new appEvents.PasswordReset(user, 1),
  RememberTokenReused: () => new appEvents.RememberTokenReused(user, { ip: '203.0.113.9', userAgent: 'Test', sessionsEnded: true }, AT),
  TwoFactorEnabled: () => new appEvents.TwoFactorEnabled(user, 'passkey'),
  TwoFactorDisabled: () => new appEvents.TwoFactorDisabled(user, 'operator'),
  RecoveryCodesGenerated: () => new appEvents.RecoveryCodesGenerated(user),
  RecoveryCodeUsed: () => new appEvents.RecoveryCodeUsed(user, 3),
  TwoFactorChallengeFailed: () => new appEvents.TwoFactorChallengeFailed(user, { during: 'confirm' }, AT),
  PasskeyRegistered: () => new appEvents.PasskeyRegistered(user, 'Laptop'),
  PasskeyRemoved: () => new appEvents.PasskeyRemoved(user, 'reset'),
  PasskeyCloneSuspected: () => new appEvents.PasskeyCloneSuspected(user, 5),
  PasskeySignInFailed: () => new appEvents.PasskeySignInFailed(user, { ip: '203.0.113.9' }, AT),
};

const { events, map } = slotEventSet('editor');
const keys = Object.keys(guardEvents('office').events).sort();
const classes = events as unknown as Record<string, new (...parameters: unknown[]) => object> & Record<string, Partial<QueueableEvent>>;

class Users extends MemoryUsers<{ id: number }> {}
const Office = defineGuard('office', { users: Users, tablePrefix: 'office_' }) as unknown as Guard;
const Desk = defineGuard('desk', { users: Users, tablePrefix: 'desk_' }) as unknown as Guard;

async function heard(registry: EventRegistry, event: object): Promise<void> {
  await new EventDispatcher(registry, { make: () => undefined } as never).dispatch(event);
}

describe("a guard slot's events", () => {
  it('has one class for each event of a guard, and none for EmailChanged, EverySessionEnded and Registered', () => {
    expect(Object.keys(events).sort()).toEqual(keys);
    for (const missing of ['EmailChanged', 'EverySessionEnded', 'Registered']) expect(events).not.toHaveProperty(missing);
  });

  it('names a class slot:editor:<Name> and a queued event slot.editor.auth.<name>, each name once', () => {
    const names: string[] = [];
    for (const key of keys) {
      expect(classes[key]!.name).toBe(`slot:editor:${key}`);
      const base = (appEvents as unknown as Record<string, Partial<QueueableEvent>>)[key]!;
      expect(classes[key]!.event, key).toBe(base.event === undefined ? undefined : `slot.editor.${base.event}`);
      if (classes[key]!.event !== undefined) {
        expect(classes[key]!.event).toMatch(NAME);
        names.push(classes[key]!.event!);
      }
    }
    expect(names).toContain('slot.editor.auth.signed-in');
    expect(new Set(names).size).toBe(names.length);
    // Not the shape of a guard's name: `<guard>.auth.<name>` has one segment less.
    expect(names.every((name) => name.startsWith('slot.editor.auth.'))).toBe(true);
  });

  it('keeps the getters of the app\'s class, and freezes the set, its classes and their prototypes', () => {
    const made = new classes.SignedIn!('office', user, { via: 'attempt' }) as { userId: number };
    expect(made.userId).toBe(7);
    expect(Object.isFrozen(events)).toBe(true);
    for (const key of keys) {
      expect(Object.isFrozen(classes[key]), key).toBe(true);
      expect(Object.isFrozen(classes[key]!.prototype), key).toBe(true);
    }
    expect(() => {
      (events as unknown as Record<string, unknown>).SignedIn = class {};
    }).toThrow(TypeError);
  });

  it('sets guard in the constructor, read-only, and refuses what is neither web nor a guard name', () => {
    const made = new classes.SignedOut!('office', user) as { guard: string };
    expect(made.guard).toBe('office');
    expect(Object.getOwnPropertyDescriptor(made, 'guard')).toMatchObject({ value: 'office', enumerable: true, writable: false });
    expect((new classes.SignedOut!('web', user) as { guard: string }).guard).toBe('web');
    for (const bad of ['nope!', '', undefined, 'auth', 7]) expect(() => new classes.SignedOut!(bad, user), String(bad)).toThrow(TypeError);
  });

  it('never prints what it was given as the mode: an untyped caller that passes the user first leaks no record', () => {
    const record = { id: 1, email: 'ada@example.com', passwordHash: 'hash-' + 'x'.repeat(20) };
    let message = '';
    try {
      new classes.SignedOut!(record, record);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('got something else.');
    expect(message).not.toMatch(/ada@example\.com|hash-|passwordHash/);
    expect(() => new classes.SignedOut!('x'.repeat(100), user)).toThrow(`got "${'x'.repeat(32)}".`);
  });

  it.each(keys)('%s: maps to its own slot class with the getters of the app\'s, and a listener of the slot class hears it once', async (key) => {
    const base = INSTANCES[key]!();
    const mapped = map(base, 'office') as { guard: string };
    expect(mapped).toBeInstanceOf(classes[key]!);
    expect(mapped.guard).toBe('office');
    expect({ ...mapped }).toEqual({ ...base, guard: 'office' });
    for (const getter of Object.keys(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(base))).filter((name) => name !== 'constructor')) {
      expect((mapped as Record<string, unknown>)[getter], getter).toEqual((base as Record<string, unknown>)[getter]);
    }
    const registry = new EventRegistry();
    const own: object[] = [];
    const app: object[] = [];
    registry.listen(classes[key] as never, ((event: object) => void own.push(event)) as never);
    registry.listen(base.constructor as never, ((event: object) => void app.push(event)) as never);
    await heard(registry, mapped);
    expect(own).toEqual([mapped]);
    expect(app).toEqual([]);
  });

  it('maps the exact class of the app with the mode it is given, and drops every other class', () => {
    const base = new appEvents.SignedOut(user);
    const mapped = map(base, 'desk') as { guard: string; user: { id: number } };
    expect(mapped).toBeInstanceOf(classes.SignedOut!);
    expect(mapped).not.toBeInstanceOf(appEvents.SignedOut);
    expect(mapped.guard).toBe('desk');
    expect(mapped.user.id).toBe(7);
    expect(map(new appEvents.Registered(user), 'web')).toBeUndefined();
    expect(map(new (class extends appEvents.SignedOut {})(user), 'web')).toBeUndefined();
    expect(map({}, 'web')).toBeUndefined();
  });

  it('is heard by a listener of the slot\'s class and by none of the app\'s or a guard\'s', async () => {
    const registry = new EventRegistry();
    const heardBy: string[] = [];
    registry.listen(appEvents.SignedOut, (() => void heardBy.push('app')) as never);
    registry.listen(guardEvents('office').events.SignedOut as never, (() => void heardBy.push('guard')) as never);
    registry.listen(classes.SignedOut as never, (() => void heardBy.push('slot')) as never);
    await heard(registry, map(new appEvents.SignedOut(user), 'web')!);
    expect(heardBy).toEqual(['slot']);
  });

  describe('payload', () => {
    const schema = (key: string) => classes[key]!.schema!['~standard'];
    const queued = { userId: 7, remember: true, via: 'attempt', at: AT.toISOString(), ip: '203.0.113.9', userAgent: 'Test' };
    const signedIn = () => new appEvents.SignedIn(user, { remember: true, via: 'attempt', ip: '203.0.113.9', userAgent: 'Test' }, AT);

    it('adds the slot and the mode of the event', async () => {
      expect(await schema('SignedIn').validate(map(signedIn(), 'office'))).toEqual({ typed: true, value: { ...queued, guard: 'office', slot: 'editor' } });
      expect(await schema('SignedIn').validate(map(signedIn(), 'web'))).toEqual({ typed: true, value: { ...queued, guard: 'web', slot: 'editor' } });
    });

    it('never overwrites the guard of a queued payload: web stays web and office stays office', async () => {
      expect(await schema('SignedIn').validate({ ...queued, guard: 'web' })).toEqual({ typed: true, value: { ...queued, guard: 'web', slot: 'editor' } });
      expect(await schema('SignedIn').validate({ ...queued, guard: 'office' })).toEqual({ typed: true, value: { ...queued, guard: 'office', slot: 'editor' } });
      // The slot is the class's own, whatever the payload says.
      expect(await schema('SignedIn').validate({ ...queued, guard: 'office', slot: 'other' })).toEqual({ typed: true, value: { ...queued, guard: 'office', slot: 'editor' } });
    });

    it('is an issue on guard for a missing or malformed guard, and an issue of the app\'s schema stays one', async () => {
      for (const bad of [{}, { guard: undefined }, { guard: 'nope!' }, { guard: '' }, { guard: 7 }, { guard: 'auth' }]) {
        expect(await schema('SignedIn').validate({ ...queued, ...bad }), JSON.stringify(bad)).toEqual({ issues: [{ message: "guard is 'web' or a guard's name", path: ['guard'] }] });
      }
      expect((await schema('SignedIn').validate({ userId: 'x', guard: 'web' })).issues?.[0]?.message).not.toBe("guard is 'web' or a guard's name");
    });
  });

  it('gives two slots of one name classes of their own and one queue name', () => {
    const other = slotEventSet('editor');
    expect(other.events.SignedIn).not.toBe(events.SignedIn);
    expect((other.events.SignedIn as { event: string }).event).toBe((events.SignedIn as { event: string }).event);
  });

  it('knows the slot of its classes, and of no other class', () => {
    const slot = defineGuardSlot<{ id: number }>('owned');
    expect(slotOfEvent(slot.events.SignedIn)).toEqual({ slot, name: 'owned' });
    expect(slotOfEvent(appEvents.SignedIn)).toBeUndefined();
    expect(slotOfEvent(guardEvents('office').events.SignedIn)).toBeUndefined();
    expect(slotOfEvent('SignedIn')).toBeUndefined();
  });
});

describe('the slots a container binds', () => {
  const signedOut = () => new appEvents.SignedOut(user);
  const guards = (container: Container, target: 'web' | Guard, base = signedOut()) => slotEventsFor(container, target, base).map((event) => (event as { guard: string }).guard);

  it('gives each container its own target: no state is shared between two containers that bind one slot differently', () => {
    const slot = defineGuardSlot<{ id: number }>('shared');
    const one = new Container();
    const two = new Container();
    slot.bind(one, Office as never);
    slot.bind(two, 'web');
    expect(guards(one, Office)).toEqual(['office']);
    expect(guards(one, 'web')).toEqual([]);
    expect(guards(two, 'web')).toEqual(['web']);
    expect(guards(two, Office)).toEqual([]);
  });

  it('compares the target by identity: another guard of the same name does not count', () => {
    const slot = defineGuardSlot<{ id: number }>('identity');
    const container = new Container();
    slot.bind(container, Office as never);
    const lookalike = defineGuard('office', { users: Users, tablePrefix: 'office_' }) as unknown as Guard;
    expect(guards(container, lookalike)).toEqual([]);
    expect(guards(container, Desk)).toEqual([]);
  });

  it('gives nothing without any binding, for an unbound slot, and for an event the slot has no class of', () => {
    expect(slotEventsFor(new Container(), 'web', signedOut())).toEqual([]);
    const unbound = new Container();
    defineGuardSlot<{ id: number }>('unbound');
    expect(slotEventsFor(unbound, 'web', signedOut())).toEqual([]);
    const container = new Container();
    defineGuardSlot<{ id: number }>('bound-elsewhere').bind(container, 'web');
    expect(slotEventsFor(container, 'web', new appEvents.Registered(user))).toEqual([]);
  });

  it('relays nothing for a slot that is not bound while another slot of the container is: no fallback to the target of its neighbour', () => {
    const bound = defineGuardSlot<{ id: number }>('neighbour-bound');
    const unbound = defineGuardSlot<{ id: number }>('neighbour-unbound');
    const container = new Container();
    bound.bind(container, 'web');
    expect(slotEventsFor(container, 'web', signedOut()).map((event) => event.constructor.name)).toEqual(['slot:neighbour-bound:SignedOut']);
    expect(slotEventsFor(container, Office, signedOut())).toEqual([]);
    expect(slotOfEvent(unbound.events.SignedOut)?.slot).toBe(unbound);
  });

  it('relays one event for each slot bound to the target, in binding order', () => {
    const first = defineGuardSlot<{ id: number }>('first');
    const second = defineGuardSlot<{ id: number }>('second');
    const container = new Container();
    first.bind(container, Desk as never);
    second.bind(container, Desk as never);
    expect(slotEventsFor(container, Desk, signedOut()).map((event) => event.constructor.name)).toEqual(['slot:first:SignedOut', 'slot:second:SignedOut']);
  });
});
