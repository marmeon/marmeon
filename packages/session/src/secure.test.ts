import { createApplication, Logger, type Container, type LogContext } from '@marmeon/core';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { CookieDefaults, HttpServiceProvider } from '@marmeon/http';
import { CookieJar } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { insecureCookieWarning, SessionConfig } from './config.ts';
import { SessionServiceProvider } from './provider.ts';
import { CookieSessionStore } from './stores/cookie.ts';

/** Boots the session with `env` — its config, the cookie defaults it binds, and what it warned about. */
async function boot(env: Record<string, string>) {
  const warnings: string[] = [];
  const logger: Logger = { debug() {}, info() {}, warn: (message: string, _context?: LogContext) => void warnings.push(message), error() {}, child: () => logger };
  const app = await createApplication({
    root: import.meta.dirname,
    discover: false,
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', ...env },
    providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider],
    override: (container: Container) => container.instance(Logger, logger),
  });
  return { config: app.container.make(SessionConfig), defaults: app.container.make(CookieDefaults), warnings };
}

describe('SESSION_SECURE_COOKIE follows APP_URL (E162)', () => {
  it('https:// → Secure, http:// → not; true/false decide themselves — and every cookie of the request follows', async () => {
    expect((await boot({ NODE_ENV: 'test', APP_URL: 'https://example.com' })).defaults).toEqual({ secure: true });
    expect((await boot({ NODE_ENV: 'test', APP_URL: 'http://localhost:3000' })).defaults).toEqual({ secure: false });
    expect((await boot({ NODE_ENV: 'test' })).config.secure).toBe(false);
    expect((await boot({ NODE_ENV: 'test', APP_URL: 'http://localhost', SESSION_SECURE_COOKIE: 'true' })).config).toMatchObject({ secure: true, secureFrom: 'SESSION_SECURE_COOKIE' });
    expect((await boot({ NODE_ENV: 'test', APP_URL: 'https://example.com', SESSION_SECURE_COOKIE: 'false' })).config).toMatchObject({ secure: false, secureFrom: 'SESSION_SECURE_COOKIE' });
    expect((await boot({ NODE_ENV: 'test', APP_URL: 'https://example.com', SESSION_SECURE_COOKIE: '' })).config).toMatchObject({ secure: true, secureFrom: 'APP_URL' });
  });

  it('warns once at boot when a protected environment sends cookies without Secure — never in development or test', async () => {
    expect((await boot({ NODE_ENV: 'production', APP_URL: 'http://example.com' })).warnings).toEqual([insecureCookieWarning('APP_URL')]);
    expect((await boot({ NODE_ENV: 'staging', APP_URL: 'https://example.com', SESSION_SECURE_COOKIE: 'false' })).warnings).toEqual([insecureCookieWarning('SESSION_SECURE_COOKIE')]);
    expect((await boot({ APP_URL: 'http://example.com' })).warnings).toEqual([insecureCookieWarning('APP_URL')]); // no NODE_ENV = protected (E139)
    expect((await boot({ NODE_ENV: 'production', APP_URL: 'https://example.com' })).warnings).toEqual([]);
    expect((await boot({ NODE_ENV: 'development', APP_URL: 'http://localhost:3000' })).warnings).toEqual([]);
    expect(insecureCookieWarning('APP_URL')).toContain('APP_URL is not https://');
  });

  it('the cookie store\'s cookie follows the jar\'s defaults (it sets no secure itself)', async () => {
    const jar = new CookieJar(null, { secure: true });
    await new CookieSessionStore(jar, 'app_session').write('id', '{"a":"1"}', { expectedVersion: undefined, lifetimeSeconds: 60 });
    expect(await jar.queued()).toEqual([expect.stringMatching(/^app_session_data=.*; Secure; SameSite=Lax$/)]);
  });
});
