import { createApplication, defineModule, type Container } from '@marmeon/core';
import { CacheServiceProvider } from '@marmeon/cache';
import { DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { AuthServiceProvider, EndSessionsCommand, ResetTwoFactorCommand, TwoFactorState, UserProvider, type AuthUser } from './index.ts';
import { MemoryUsers } from './test-helpers/users.ts';

const ada: AuthUser = { id: 1, name: 'Ada', email: 'ada@example.com' };

// The commands are built by the container, from what the provider binds: the injection list has to match the constructors.
async function boot() {
  const users = new MemoryUsers<AuthUser>();
  users.add(ada);
  const application = await createApplication({
    root: import.meta.dirname,
    discover: false,
    providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
    modules: [defineModule({ name: 'auth-operator-commands-test', migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
  }, {
    env: { APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', DB_DATABASE: ':memory:', CACHE_DRIVER: 'memory' },
    override: (container: Container) => {
      container.instance(UserProvider, users as UserProvider);
    },
  });
  await application.container.make(Migrator).migrate();
  const lines: string[] = [];
  const output = { line: (line: string) => lines.push(line), success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
  const input = (args: string[]) => ({ args, options: { force: true }, output, root: '/', spawn: async () => 0 }) as never;
  return { container: application.container, lines, input };
}

/** Built as `marmeon` does (`runCommand`): the injection list of a command is not checked against its constructor. */
const build = <C extends new (...args: never[]) => unknown>(container: Container, Command: C) => container.make(Command as never) as InstanceType<C> & { handle(input: never): Promise<number> };

describe('the operator commands built by the container', () => {
  it('auth:end-sessions exits 1 for an unknown identifier', async () => {
    const { container, lines, input } = await boot();
    expect(await build(container, EndSessionsCommand).handle(input(['nobody@example.com']))).toBe(1);
    expect(lines).toEqual([expect.stringContaining('No account has the identifier nobody@example.com')]);
  });

  it('auth:reset-two-factor exits 1 for an unknown identifier', async () => {
    const { container, lines, input } = await boot();
    expect(await build(container, ResetTwoFactorCommand).handle(input(['nobody@example.com']))).toBe(1);
    expect(lines).toEqual([expect.stringContaining('No account has the identifier nobody@example.com')]);
  });

  it('auth:reset-two-factor reports an account without a second factor when none is bound', async () => {
    const { container, lines, input } = await boot();
    expect(container.make(TwoFactorState).constructor.name).toBe('NoTwoFactorState');
    expect(await build(container, ResetTwoFactorCommand).handle(input(['ada@example.com']))).toBe(0);
    expect(lines).toEqual(['ada@example.com has no second factor.']);
  });

  it('auth:end-sessions ends the sessions of a known account', async () => {
    const { container, lines, input } = await boot();
    expect(await build(container, EndSessionsCommand).handle(input(['ada@example.com']))).toBe(0);
    expect(lines).toEqual([expect.stringContaining('of ada@example.com;')]);
  });
});
