import { CacheServiceProvider, clientKey, Limit, RateLimiter, type LimiterCallback } from '@marmeon/cache';
import { createApplication, type Application, type ServiceProvider } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AuthServiceProvider } from './index.ts';
import { defineAuthRouteLimits } from './route-limits.ts';

const NAMES = [
  'auth.login',
  'auth.register',
  'auth.password-reset-link',
  'auth.password-reset',
  'auth.two-factor-challenge',
  'auth.passkey-sign-in-options',
  'auth.passkey-sign-in',
  'auth.passkey-challenge-options',
  'auth.passkey-challenge',
  'auth.passkey-confirm-options',
  'auth.passkey-step-up-options',
  'auth.verification',
  'auth.email-change',
];

const ctx = (ip: string, user?: { id: number }) => ({ ip, user }) as unknown as Parameters<LimiterCallback>[0];

/** Defines the limiters of the app's own provider by `name`, in its `boot()`. */
function appLimiter(name: string, attempts: number): new () => ServiceProvider {
  return class {
    boot(app: Application) {
      app.container.make(RateLimiter).for(name, () => Limit.perMinute(attempts).by('app'));
    }
  };
}

async function boot(providers: (new () => ServiceProvider)[]) {
  const application = await createApplication(
    { root: import.meta.dirname, discover: false, providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, ...providers] },
    { env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', CACHE_DRIVER: 'memory' } },
  );
  return application.container.make(RateLimiter);
}

describe('the limits of the auth routes', () => {
  it('defines every name when the provider boots', async () => {
    const limiter = await boot([AuthServiceProvider]);
    for (const name of NAMES) expect(limiter.limiter(name), name).toBeTypeOf('function');
  });

  it('counts a client by its address block and a signed-in user by id', async () => {
    const limiter = await boot([AuthServiceProvider]);
    const login = await limiter.limiter('auth.login')!(ctx('2001:db8::1'));
    expect(login).toEqual(Limit.perMinute(30).by(clientKey('2001:db8::1')));
    expect(login).toEqual(await limiter.limiter('auth.login')!(ctx('2001:db8::2')));
    expect(await limiter.limiter('auth.email-change')!(ctx('203.0.113.9', { id: 7 }))).toEqual(Limit.perMinute(6).by('7'));
    expect(await limiter.limiter('auth.verification')!(ctx('203.0.113.9', { id: 7 }))).toEqual([Limit.perMinute(3).by('7'), Limit.perDay(10).by('7')]);
    // A route that is not behind authenticate() still counts something: the client.
    expect(await limiter.limiter('auth.verification')!(ctx('203.0.113.9'))).toEqual([Limit.perMinute(3).by('203.0.113.9'), Limit.perDay(10).by('203.0.113.9')]);
  });

  it('lets an app limiter of the same name win when it is defined before the package boots', async () => {
    const limiter = await boot([appLimiter('auth.register', 99), AuthServiceProvider]);
    expect(await limiter.limiter('auth.register')!(ctx('203.0.113.9'))).toEqual(Limit.perMinute(99).by('app'));
    expect(await limiter.limiter('auth.login')!(ctx('203.0.113.9'))).toEqual(Limit.perMinute(30).by('203.0.113.9'));
  });

  it('lets an app limiter of the same name win when it is defined after the package boots', async () => {
    const limiter = await boot([AuthServiceProvider, appLimiter('auth.register', 99)]);
    expect(await limiter.limiter('auth.register')!(ctx('203.0.113.9'))).toEqual(Limit.perMinute(99).by('app'));
  });

  it('leaves a limiter alone that an earlier definition made', async () => {
    const limiter = await boot([]);
    limiter.for('auth.login', () => Limit.perMinute(1).by('mine'));
    defineAuthRouteLimits(limiter);
    expect(await limiter.limiter('auth.login')!(ctx('203.0.113.9'))).toEqual(Limit.perMinute(1).by('mine'));
    expect(limiter.limiter('auth.register')).toBeTypeOf('function');
  });
});
