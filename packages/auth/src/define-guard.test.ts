import { Container, type Resolver } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { AuthConfig } from './config.ts';
import { defineGuard, Guard, GuardRegistry, guardRegistry, hasPackageGuards } from './define-guard.ts';
import { MemoryUsers } from './test-helpers/users.ts';

class Users extends MemoryUsers<{ readonly id: number }> {}

const app = {
  rememberDays: 30,
  remember: true,
  sessionMaxSeconds: 86_400,
  rememberCookie: 'marmeon_remember',
  loginAttemptsPerMinute: 5,
  accountSignInsPerDay: 100,
  deviceCookieDays: 90,
  passwordTimeoutSeconds: 900,
  resetMinutes: 60,
  resetThrottleSeconds: 60,
} as unknown as AuthConfig;
const resolver = { make: (key: unknown) => (key === AuthConfig ? app : undefined) } as unknown as Resolver;

const settingsOf = (guard: unknown, given: Resolver = resolver) => (guard as Guard).settings(given);

describe('the settings of a guard', () => {
  it('are the app\'s where the guard says nothing', () => {
    expect(settingsOf(defineGuard('office', { users: Users, tablePrefix: 'office_' }))).toEqual(app);
  });

  it('lay over the app\'s, the units converted as the environment variables are', () => {
    const guard = defineGuard('office', {
      users: Users,
      tablePrefix: 'office_',
      settings: { rememberDays: 0, sessionMaxHours: 8, passwordTimeoutSeconds: 60, loginAttemptsPerMinute: 10, accountSignInsPerDay: 20, deviceCookieDays: 0, resetMinutes: 15, resetThrottleSeconds: 0 },
    });
    expect(settingsOf(guard)).toEqual({
      ...app,
      rememberDays: 0,
      remember: false,
      sessionMaxSeconds: 8 * 3600,
      passwordTimeoutSeconds: 60,
      loginAttemptsPerMinute: 10,
      accountSignInsPerDay: 20,
      deviceCookieDays: 0,
      resetMinutes: 15,
      resetThrottleSeconds: 0,
    });
    expect(app.rememberDays, 'the app\'s own object is not written to').toBe(30);
  });

  it('may come from a function that reads the container, and are checked when it answers', () => {
    const seen: Resolver[] = [];
    const guard = defineGuard('office', {
      users: Users,
      tablePrefix: 'office_',
      settings: (given) => {
        seen.push(given);
        return { rememberDays: 3 };
      },
    });
    expect(settingsOf(guard).rememberDays).toBe(3);
    expect(seen).toEqual([resolver]);
    const bad = defineGuard('office', { users: Users, tablePrefix: 'office_', settings: () => ({ accountSignInsPerDay: 9 }) });
    expect(() => settingsOf(bad)).toThrow(/\[marmeon:A8\].*accountSignInsPerDay/);
    const notAnObject = defineGuard('office', { users: Users, tablePrefix: 'office_', settings: (() => 7) as never });
    expect(() => settingsOf(notAnObject)).toThrow(/\[marmeon:A8\]/);
  });

  it.each([
    ['rememberDays', -1],
    ['rememberDays', 31],
    ['sessionMaxHours', 0],
    ['sessionMaxHours', 721],
    ['passwordTimeoutSeconds', 0],
    ['loginAttemptsPerMinute', 61],
    ['accountSignInsPerDay', 100_001],
    ['deviceCookieDays', 366],
    ['resetMinutes', 1441],
    ['resetThrottleSeconds', -1],
    ['rememberDays', '3'],
    ['rememberDays', Number.NaN],
    ['rememberDays', Infinity],
  ])('refuse %s of %s', (key, value) => {
    expect(() => defineGuard('office', { users: Users, tablePrefix: 'office_', settings: { [key]: value } as never })).toThrow(/\[marmeon:A8\]/);
  });
});

describe('a guard\'s tokens', () => {
  it('are its own: two guards never share a key, and neither is a key of the app', () => {
    const a = defineGuard('first', { users: Users, tablePrefix: 'first_' });
    const b = defineGuard('second', { users: Users, tablePrefix: 'second_' });
    expect(new Set([a.Auth, a.AccountSessions, a.PasswordBroker, b.Auth, b.AccountSessions, b.PasswordBroker]).size).toBe(6);
    expect(a.name).toBe('first');
    expect(a.tablePrefix).toBe('first_');
  });
});

describe('the guard registry', () => {
  it('is made once per container, by whoever asks first', () => {
    const container = new Container();
    expect(hasPackageGuards(container)).toBe(false);
    expect(guardRegistry(container)).toBe(guardRegistry(container));
    expect(container.make(GuardRegistry)).toBe(guardRegistry(container));
    expect(hasPackageGuards(container)).toBe(false);
    defineGuard('office', { users: Users, tablePrefix: 'office_' }).register(container);
    expect(hasPackageGuards(container)).toBe(true);
  });

  it('binds the guard\'s services under its tokens and leaves the app\'s keys alone', () => {
    const container = new Container();
    const guard = defineGuard('office', { users: Users, tablePrefix: 'office_' });
    guard.register(container);
    for (const key of [guard.Auth, guard.AccountSessions, guard.PasswordBroker]) expect(container.has(key)).toBe(true);
    expect(container.has(AuthConfig)).toBe(false);
  });
});
