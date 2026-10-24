import { createApplication, type Container, type Logger } from '@marmeon/core';
import { DatabaseServiceProvider } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it, vi } from 'vitest';
import type { AccountSessions } from './account-sessions.ts';
import { Auth } from './auth.ts';
import { EndSessionsCommand } from './end-sessions.ts';
import { AuthServiceProvider } from './index.ts';
import { PasswordBroker } from './password-reset.ts';
import { assertSignInFinder, UserProvider } from './user.ts';

const rest = {
  findById: async () => undefined,
  updatePasswordHash: async () => true,
  updateSessionKey: async () => true,
  updateEverySessionKey: async () => ({ accounts: 0, sampleId: 0 }),
};

/** A provider as an app wrote it before the method was renamed. */
class OldProvider {
  findById = rest.findById;
  updatePasswordHash = rest.updatePasswordHash;
  updateSessionKey = rest.updateSessionKey;
  updateEverySessionKey = rest.updateEverySessionKey;
  async findForLogin() {
    return undefined;
  }
}

describe('a UserProvider with the old name findForLogin()', () => {
  it('does not compile as a UserProvider', () => {
    // @ts-expect-error findForSignIn() is missing
    const provider: UserProvider = new OldProvider();
    expect(provider).toBeInstanceOf(OldProvider);
  });

  it('stops with a message that names findForSignIn(), not a bare "is not a function" or an unknown account', () => {
    const old = new OldProvider() as unknown as UserProvider;
    expect(() => assertSignInFinder(old)).toThrow(/OldProvider\.findForLogin\(\) was renamed findForSignIn\(\)/);
    expect(() => assertSignInFinder(old)).toThrow(/A5/);
  });

  it('is refused by the commands that look an account up', async () => {
    const command = new EndSessionsCommand(new OldProvider() as unknown as UserProvider, {} as AccountSessions, {} as Logger);
    await expect(command.handle({ args: ['ada@example.com'], options: { force: true }, output: {} } as never)).rejects.toThrow(/renamed findForSignIn\(\)/);
  });

  it('stops the boot of the app, not the first sign-in or a queued job', async () => {
    const boot = createApplication({
      root: import.meta.dirname,
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, SessionServiceProvider, DatabaseServiceProvider, AuthServiceProvider],
    }, {
      env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', DB_DATABASE: ':memory:', LOG_LEVEL: 'silent', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' },
      override: (container: Container) => container.instance(UserProvider, new OldProvider() as unknown as UserProvider),
    });
    await expect(boot).rejects.toThrow(/A5.*renamed findForSignIn\(\)/s);
  });

  it('is refused by attempt() with the same message, not as invalid-credentials', async () => {
    const auth = new Auth(
      {} as never,
      new OldProvider() as unknown as UserProvider,
      { failureFloorMs: () => 0 } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { ip: '127.0.0.1' } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { takeClient: async () => undefined } as never,
    );
    await expect(auth.attempt('ada@example.com', 'secret')).rejects.toThrow(/renamed findForSignIn\(\)/);
  });

  it('is refused by reset() before the token is spent', async () => {
    const consume = vi.fn();
    const broker = new PasswordBroker(
      new OldProvider() as unknown as UserProvider,
      { consume } as never,
      {} as never,
      {} as never,
      { resetExpire: 60 } as never,
      { assertReady() {} } as never,
      {} as never,
    );
    await expect(broker.reset('ada@example.com', 'token', 'new password')).rejects.toThrow(/renamed findForSignIn\(\)/);
    expect(consume).not.toHaveBeenCalled();
  });

  it('lets a provider with the new name through, and one with neither (the plain TypeError says the rest)', () => {
    expect(() => assertSignInFinder({ ...rest, findForSignIn: async () => undefined } as unknown as UserProvider)).not.toThrow();
    expect(() => assertSignInFinder({ ...rest } as unknown as UserProvider)).not.toThrow();
  });
});
