import { Redactor, type Logger, type LogContext } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { AccountSessions } from './account-sessions.ts';
import { signInStore } from './test-helpers/stores.ts';
import type { AuthUser, Credentials, UserProvider } from './user.ts';

const ada: AuthUser = { id: 7, name: 'Ada', email: 'ada@example.com' };
const leak = 'Cookie: a=1; marmeon_session=s3ss10nvalue';

const users = (overrides: Partial<UserProvider> = {}) =>
  ({
    findById: async () => ({ user: ada, passwordHash: null, sessionKey: 'k' }) satisfies Credentials,
    findForSignIn: async () => undefined,
    updatePasswordHash: async () => {},
    updateSessionKey: async () => true,
    updateEverySessionKey: async () => ({ accounts: 1, sampleId: ada.id }),
    ...overrides,
  }) as unknown as UserProvider;

/** A logger that writes what the real one writes: the message as given, the context through the app's Redactor. */
function recordingLogger() {
  const redactor = new Redactor().addKeys('marmeon_session');
  const entries: string[] = [];
  const record = (message: string, context?: LogContext) => void entries.push(JSON.stringify({ message, context: redactor.log(context ?? {}) }));
  const logger: Logger = { debug: record, info: record, warn: record, error: record, child: () => logger };
  return { logger, entries };
}

describe('errors that quote a secret stay out of the log', () => {
  it('endEveryone(): neither the message nor the error field holds the cause, the thrown error keeps it', async () => {
    const { logger, entries } = recordingLogger();
    const signIns = signInStore({ endEveryone: async () => Promise.reject(new Error(`store refused: ${leak}`)) });
    const accounts = new AccountSessions(users(), signIns, undefined, undefined, undefined, undefined, undefined, logger);
    const thrown = (await accounts.endEveryone({ accessTokens: false, resetTokens: false }).catch((error: unknown) => error)) as Error;
    expect(thrown.message).toContain('s3ss10nvalue');
    expect(thrown.cause).toBeInstanceOf(Error);
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain('s3ss10nvalue');
    expect(entries[0]).toContain('[redacted]');
    expect(JSON.parse(entries[0]!).context.error).toMatchObject({ type: 'Error' });
  });

  it('endEveryone(): live streams that cannot be told are logged masked', async () => {
    const { logger, entries } = recordingLogger();
    const endings = { endAccount: async () => Promise.reject(new Error(leak)), endEverySession: async () => Promise.reject(new Error(leak)) };
    let key: string | null = null;
    const provider = users({
      findById: async () => ({ user: ada, passwordHash: null, sessionKey: key }),
      updateEverySessionKey: async (next: string) => ((key = next), { accounts: 1, sampleId: ada.id }),
    });
    const accounts = new AccountSessions(provider, signInStore({ endEveryone: async () => 1 }), undefined, undefined, undefined, undefined, undefined, logger, endings as never);
    await accounts.endEveryone({ accessTokens: false, resetTokens: false });
    expect(entries.some((entry) => entry.includes('could not be told'))).toBe(true);
    for (const entry of entries) expect(entry).not.toContain('s3ss10nvalue');
  });
});
