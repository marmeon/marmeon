import { CacheServiceProvider } from '@marmeon/cache';
import { Clock, createApplication, defineModule, EventRegistry, Logger, type Container, type ServiceProvider } from '@marmeon/core';
import { TestClock } from '@marmeon/core/testing';
import { Connections, DatabaseServiceProvider, Migrator } from '@marmeon/database';
import { EncryptionServiceProvider, generateKey } from '@marmeon/encryption';
import { HttpServiceProvider } from '@marmeon/http';
import { ServerServiceProvider } from '@marmeon/server';
import { SessionServiceProvider } from '@marmeon/session';
import { describe, expect, it } from 'vitest';
import { workspaceTempDir } from '../../../scripts/test/temp-dir.js';
import { defineGuard, type Guard, type GuardSettings } from './define-guard.ts';
import { EndAllSessionsCommand } from './end-all-sessions.ts';
import { EndSessionsCommand } from './end-sessions.ts';
import { TwoFactorDisabled } from './events.ts';
import { AuthServiceProvider, combineFactors, TwoFactorState, TwoFactorStore, UserProvider, type AuthUser } from './index.ts';
import { PasskeyConfig, PasskeyServiceProvider, PasskeyStore } from './passkeys/index.ts';
import { Passkeys } from './passkeys/passkeys.ts';
import { PasswordResetTokenStore } from './password-reset.ts';
import { PruneTokensCommand } from './prune-tokens.ts';
import { ResetTwoFactorCommand } from './reset-two-factor.ts';
import { SignInStore } from './sign-ins.ts';
import { MemoryUsers } from './test-helpers/users.ts';
import { TwoFactor } from './two-factor/two-factor.ts';

interface OfficeUser {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}

// The same id 1 and address in both tables: only the guard tells the accounts apart.
const app = new MemoryUsers<AuthUser>();
const office = new MemoryUsers<OfficeUser>();

class OfficeUsers extends MemoryUsers<OfficeUser> {
  constructor() {
    super();
    return office;
  }
}

// What the guard's settings are for the test at hand: the guard reads them when it is first used.
let officeSettings: GuardSettings = {};

const OfficeGuard = defineGuard('office', { users: OfficeUsers, tablePrefix: 'office_', twoFactor: TwoFactor, passkeys: Passkeys, settings: () => officeSettings });
const guard = OfficeGuard as unknown as Guard;

class OfficeProvider implements ServiceProvider {
  static config = [PasskeyConfig];
  register(container: Container): void {
    OfficeGuard.register(container);
  }
}

/** A dependency that exists in a scope only: whoever asks the root container for it fails with K2. */
class ScopedNote {}

const heard: string[] = [];

/** A class listener with a scoped dependency, as an app's mail listener has one. */
class HearReset {
  static inject = [ScopedNote];
  constructor(_note: ScopedNote) {}
  handle(event: TwoFactorDisabled): void {
    heard.push(event.via);
  }
}

interface BootOptions {
  /** Where the app's `UserProvider` comes from: the root, a scope only, or nowhere (an app whose only users belong to a guard). */
  appUsers?: 'bound' | 'scoped' | 'none';
  appEnv?: Record<string, string>;
  settings?: GuardSettings;
  /** How long after the rows were made the command runs. */
  travel?: { days?: number; minutes?: number };
  /** Gives every sign-in a remember-me token that lasts ten days. */
  remember?: boolean;
}

/** An app and a package guard `office`, each with an account 1 at ada@example.com, a sign-in, a reset link and every kind of second factor. */
async function boot({ appUsers = 'bound', appEnv = {}, settings = {}, travel = { days: 2 }, remember = false }: BootOptions = {}) {
  officeSettings = settings;
  heard.length = 0;
  const infos: [string, unknown][] = [];
  const logger = { debug() {}, info: (message: string, context?: unknown) => void infos.push([message, context]), warn() {}, error() {}, child: () => logger } as unknown as Logger;
  app.rows.clear();
  office.rows.clear();
  const clock = new TestClock();
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-guard-commands-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, OfficeProvider, AuthServiceProvider, PasskeyServiceProvider],
      modules: [
        defineModule({ name: 'guard-commands-test', migrations: new URL('./__fixtures__/migrations/', import.meta.url) }),
        defineModule({ name: 'guard-commands-office', migrations: new URL('./__fixtures__/office-migrations/', import.meta.url) }),
      ],
    },
    {
      env: { NODE_ENV: 'test', APP_KEY: generateKey(), APP_NAME: 'Acme', APP_URL: 'http://localhost:3000', SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1', ...appEnv },
      override: (container: Container) => {
        container.instance(Clock, clock);
        container.instance(Logger, logger);
        if (appUsers === 'bound') container.instance(UserProvider, app as unknown as UserProvider);
        if (appUsers === 'scoped') container.scoped(UserProvider, () => app as unknown as UserProvider);
        container.scoped(ScopedNote);
        container.singleton(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore), c.make(PasskeyStore)));
      },
    },
  );
  const { container } = application;
  await container.make(Migrator).migrate();
  app.add({ id: 1, name: 'App Ada', email: 'ada@example.com' }, null, 'app-key');
  office.add({ id: 1, name: 'Office Ada', email: 'ada@example.com' }, null, 'office-key');
  const db = container.make(Connections).get<any>() as any;
  const count = async (table: string) => Number((await db.selectFrom(table).select(db.fn.countAll().as('n')).executeTakeFirst()).n);

  // The sign-ins and the reset links of both, then two days pass: every reset link is expired and every sign-in is over.
  const apps = { signIns: container.make(SignInStore), resets: container.make(PasswordResetTokenStore) };
  const offices = { signIns: container.make(guard.tokens.signIns), resets: container.make(guard.tokens.passwordResets) };
  for (const stores of [apps, offices]) {
    const id = await stores.signIns.create({ userId: 1, userAgent: 'browser' });
    if (remember) await stores.signIns.issueToken(1, id, { until: new Date(clock.now() + 10 * 86_400_000), fingerprint: 'fp' });
    await stores.resets.create('ada@example.com', 0);
  }
  const now = new Date(clock.now()).toISOString();
  for (const prefix of ['', 'office_']) {
    await db.insertInto(`${prefix}two_factor_authentications`).values({ user_id: 1, secret: 'secret', confirmed_at: now, created_at: now, updated_at: now }).execute();
    await db.insertInto(`${prefix}two_factor_recovery_codes`).values({ user_id: 1, code_hash: 'a'.repeat(64), created_at: now, updated_at: now }).execute();
    await db
      .insertInto(`${prefix}passkeys`)
      .values({ user_id: 1, user_handle: 'handle', credential_id: `${prefix}credential`, public_key: 'key', algorithm: -7, sign_count: 0, transports: '[]', aaguid: 'a'.repeat(36), backup_eligible: false, backed_up: false, name: 'Laptop', created_at: now, updated_at: now })
      .execute();
  }
  clock.travel(travel);

  const lines: string[] = [];
  const output = { line: (line: string) => lines.push(line), success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
  const run = <C extends new (...args: never[]) => unknown>(Command: C, args: string[], options: Record<string, unknown>) =>
    // Built in a scope of its own, as a command run is: what only a scope can make is there for the command, and the root is not asked for it.
    (container.createScope().make(Command as never) as { handle(input: never): Promise<number> }).handle({ args, options, output, root: '/', spawn: async () => 0 } as never);
  const tables = async () => ({
    signIns: [await count('sign_ins'), await count('office_sign_ins')],
    resets: [await count('password_reset_tokens'), await count('office_password_reset_tokens')],
    factors: [await count('two_factor_authentications'), await count('office_two_factor_authentications')],
    recoveryCodes: [await count('two_factor_recovery_codes'), await count('office_two_factor_recovery_codes')],
    passkeys: [await count('passkeys'), await count('office_passkeys')],
  });
  return { run, lines, tables, container, infos };
}

/** An app that has no package guard and no users of its own. */
async function bootWithoutGuards() {
  const application = await createApplication(
    {
      root: workspaceTempDir('marmeon-guard-commands-'),
      discover: false,
      providers: [EncryptionServiceProvider, HttpServiceProvider, ServerServiceProvider, SessionServiceProvider, DatabaseServiceProvider, CacheServiceProvider, AuthServiceProvider],
      modules: [defineModule({ name: 'guard-commands-bare', migrations: new URL('./__fixtures__/migrations/', import.meta.url) })],
    },
    { env: { NODE_ENV: 'test', APP_KEY: generateKey(), SESSION_DRIVER: 'memory', LOG_LEVEL: 'silent', CACHE_DRIVER: 'memory', DB_DATABASE: ':memory:', HASH_ARGON_MEMORY_KB: '1024', HASH_ARGON_TIME: '1' } },
  );
  await application.container.make(Migrator).migrate();
  return application.container;
}

const UNKNOWN = '✗ No guard is named "nope". The guards are: web, office.';
const KEPT = { signIns: [1, 1], resets: [1, 1], factors: [1, 1], recoveryCodes: [1, 1], passkeys: [1, 1] };

describe('the operator commands act on the guard they are told to', () => {
  it('auth:end-sessions --guard=office ends the office account and leaves the app account with the same address', async () => {
    const { run, lines, tables } = await boot();
    expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true, guard: 'office' })).toBe(0);
    expect(office.rows.get(1)!.key).not.toBe('office-key');
    expect(app.rows.get(1)!.key).toBe('app-key');
    expect((await tables()).signIns).toEqual([1, 0]);
    expect(lines).toEqual([
      'Ended every session and remember-me cookie of ada@example.com; 0 stored sessions were deleted at once, the others end at their next request. Deleted the password-reset link, if there was one.',
      'Kept: second factors, passkeys',
    ]);
  });

  it('auth:end-sessions without the option ends the app account only, with the output it always had', async () => {
    const { run, lines, tables } = await boot();
    expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true })).toBe(0);
    expect(app.rows.get(1)!.key).not.toBe('app-key');
    expect(office.rows.get(1)!.key).toBe('office-key');
    expect((await tables()).signIns).toEqual([0, 1]);
    expect(lines).toEqual([
      'Ended every session and remember-me cookie of ada@example.com; 0 stored sessions were deleted at once, the others end at their next request. Revoked 0 API tokens and deleted the password-reset link, if there was one.',
      'Kept: second factors, passkeys',
    ]);
  });

  it('auth:end-sessions --guard=web is the app', async () => {
    const { run, tables } = await boot();
    expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true, guard: 'web' })).toBe(0);
    expect(app.rows.get(1)!.key).not.toBe('app-key');
    expect(office.rows.get(1)!.key).toBe('office-key');
    expect((await tables()).signIns).toEqual([0, 1]);
  });

  it('auth:end-sessions --guard=office works in an app that has no users of its own', async () => {
    const { run, tables } = await boot({ appUsers: 'none' });
    expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true, guard: 'office' })).toBe(0);
    expect(office.rows.get(1)!.key).not.toBe('office-key');
    expect((await tables()).signIns).toEqual([1, 0]);
  });

  it('auth:reset-two-factor --guard=office removes the office authenticator, passkeys and recovery codes, and nothing of the app', async () => {
    const { run, lines, tables } = await boot();
    expect(await run(ResetTwoFactorCommand, ['ada@example.com'], { force: true, guard: 'office' })).toBe(0);
    expect(await tables()).toEqual({ ...KEPT, signIns: [1, 0], resets: [1, 0], factors: [1, 0], recoveryCodes: [1, 0], passkeys: [1, 0] });
    expect(lines).toEqual(['Removed the authenticator app, the passkeys and the recovery codes of ada@example.com, and ended its sessions.']);
    expect(app.rows.get(1)!.key).toBe('app-key');
  });

  it("auth:reset-two-factor tells the app's listeners of an app reset, and of a guard's reset none: they would mail the app's user of the same id", async () => {
    const heard = async (options: Record<string, unknown>) => {
      const { run, container } = await boot();
      const via: string[] = [];
      container.make(EventRegistry).listen(TwoFactorDisabled, (event: TwoFactorDisabled) => void via.push(event.via));
      expect(await run(ResetTwoFactorCommand, ['ada@example.com'], { force: true, ...options })).toBe(0);
      return via;
    };
    expect(await heard({})).toEqual(['operator']);
    expect(await heard({ guard: 'office' })).toEqual([]);
  });

  it('auth:reset-two-factor without the option resets the app only', async () => {
    const { run, tables } = await boot();
    expect(await run(ResetTwoFactorCommand, ['ada@example.com'], { force: true })).toBe(0);
    expect(await tables()).toEqual({ ...KEPT, signIns: [0, 1], resets: [0, 1], factors: [0, 1], recoveryCodes: [0, 1], passkeys: [0, 1] });
    expect(office.rows.get(1)!.key).toBe('office-key');
  });

  it('auth:prune-tokens prunes the app and every guard, --guard=web the app alone and --guard=office the guard alone', async () => {
    const both = await boot();
    expect(await both.run(PruneTokensCommand, [], {})).toBe(0);
    expect((await both.tables()).resets).toEqual([0, 0]);
    expect(both.lines).toEqual(['Pruned 1 password reset token, 0 API tokens and 1 sign-in.', "Pruned 1 password reset token and 1 sign-in of the guard 'office'."]);

    const web = await boot();
    expect(await web.run(PruneTokensCommand, [], { guard: 'web' })).toBe(0);
    expect(web.lines).toEqual(['Pruned 1 password reset token, 0 API tokens and 1 sign-in.']);
    expect((await web.tables()).resets).toEqual([0, 1]);

    const only = await boot();
    expect(await only.run(PruneTokensCommand, [], { guard: 'office' })).toBe(0);
    expect(only.lines).toEqual(["Pruned 1 password reset token and 1 sign-in of the guard 'office'."]);
    expect((await only.tables()).resets).toEqual([1, 0]);
    expect((await only.tables()).signIns).toEqual([1, 0]);
  });

  it('auth:end-all-sessions --guard=office is refused and ends nobody; --guard=web is the app', async () => {
    const refused = await boot();
    expect(await refused.run(EndAllSessionsCommand, [], { force: true, guard: 'office' })).toBe(1);
    expect(refused.lines).toEqual([
      "✗ auth:end-all-sessions ends the sessions of the app's accounts and is not available for the guard 'office'. To sign out one account of the guard, use auth:end-sessions <identifier> --guard=office --force. Nothing was ended.",
    ]);
    expect(await refused.tables()).toEqual(KEPT);

    const web = await boot();
    expect(await web.run(EndAllSessionsCommand, [], { force: true, guard: 'web' })).toBe(0);
    expect(web.lines.at(-1)).toContain('Not touched: passkeys');
    expect((await web.tables()).signIns).toEqual([0, 1]);
    expect(app.rows.get(1)!.key).not.toBe('app-key');
    expect(office.rows.get(1)!.key).toBe('office-key');
  });

  it.each([
    ['auth:end-sessions', EndSessionsCommand, ['ada@example.com'], { force: true }],
    ['auth:reset-two-factor', ResetTwoFactorCommand, ['ada@example.com'], { force: true }],
    ['auth:prune-tokens', PruneTokensCommand, [], {}],
    ['auth:end-all-sessions', EndAllSessionsCommand, [], { force: true }],
  ] as const)('%s refuses a guard it does not know, with the list, and touches nothing', async (_name, Command, args, options) => {
    const { run, lines, tables } = await boot();
    expect(await run(Command, [...args], { ...options, guard: 'nope' })).toBe(1);
    expect(lines.at(-1)).toBe(UNKNOWN);
    expect(await tables()).toEqual(KEPT);
    expect([app.rows.get(1)!.key, office.rows.get(1)!.key]).toEqual(['app-key', 'office-key']);
  });

  it('refuses a name that differs in case or is not a name, rather than falling back to the app', async () => {
    const { run, lines, tables } = await boot();
    expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true, guard: 'Office' })).toBe(1);
    expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true, guard: '' })).toBe(1);
    expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true, guard: true })).toBe(1);
    expect(lines).toEqual(['✗ No guard is named "Office". The guards are: web, office.', '✗ No guard is named "". The guards are: web, office.', '✗ --guard names a guard, it is not a flag. The guards are: web, office.']);
    expect(await tables()).toEqual(KEPT);
  });

  it('builds the guard in the scope of the command run: a UserProvider that only a scope can make still ends the sessions', async () => {
    const { run, tables } = await boot({ appUsers: 'scoped' });
    expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true })).toBe(0);
    expect(app.rows.get(1)!.key).not.toBe('app-key');
    expect((await tables()).signIns).toEqual([0, 1]);
  });

  it('auth:reset-two-factor tells a listener that needs a scoped dependency, and writes the log line after it', async () => {
    const { run, container, infos, tables } = await boot();
    container.make(EventRegistry).listen(TwoFactorDisabled, HearReset);
    expect(await run(ResetTwoFactorCommand, ['ada@example.com'], { force: true })).toBe(0);
    expect(heard).toEqual(['operator']);
    expect(infos).toEqual([["Removed the second factor of an account at the operator's request", { userId: 1 }]]);
    expect((await tables()).factors).toEqual([0, 1]);
  });

  it('refuses a second argument: a guard typed without --guard= must not reset or end the app account', async () => {
    const { run, tables } = await boot();
    for (const Command of [EndSessionsCommand, ResetTwoFactorCommand]) {
      for (const args of [['ada@example.com', 'office'], ['ada@example.com', '--guard=office']]) {
        await expect(run(Command, args, { force: true })).rejects.toMatchObject({
          name: 'CommandArgumentsError',
          message: `${Command.command} takes one identifier (got "${args.join(' ')}"). To act on a guard of a package, pass --guard=<name>.`,
        });
      }
    }
    expect(await tables()).toEqual(KEPT);
    expect([app.rows.get(1)!.key, office.rows.get(1)!.key]).toEqual(['app-key', 'office-key']);
  });

  it('takes --guard as the command line gives it, a list of one, and refuses two: the last must not win', async () => {
    const one = await boot();
    expect(await one.run(EndSessionsCommand, ['ada@example.com'], { force: true, guard: ['office'] })).toBe(0);
    expect((await one.tables()).signIns).toEqual([1, 0]);

    for (const guard of [['office', 'web'], ['web', 'office'], ['office', 'office']]) {
      const { run, lines, tables } = await boot();
      expect(await run(EndSessionsCommand, ['ada@example.com'], { force: true, guard })).toBe(1);
      expect(lines).toEqual(['✗ --guard is given once, not 2 times. The guards are: web, office.']);
      expect(await tables()).toEqual(KEPT);
    }
  });

  it('logs the guard next to the account for a guard, and the account alone for the app', async () => {
    const forGuard = await boot();
    await forGuard.run(EndSessionsCommand, ['ada@example.com'], { force: true, guard: 'office' });
    expect(forGuard.infos).toEqual([["Ended every session of an account at the operator's request", { userId: 1, guard: 'office' }]]);
    const forApp = await boot();
    await forApp.run(EndSessionsCommand, ['ada@example.com'], { force: true });
    expect(forApp.infos).toEqual([["Ended every session of an account at the operator's request", { userId: 1 }]]);
  });

  it('auth:reset-two-factor --guard=office works in an app that has no users of its own', async () => {
    const { run, tables } = await boot({ appUsers: 'none' });
    expect(await run(ResetTwoFactorCommand, ['ada@example.com'], { force: true, guard: 'office' })).toBe(0);
    expect(await tables()).toEqual({ ...KEPT, signIns: [1, 0], resets: [1, 0], factors: [1, 0], recoveryCodes: [1, 0], passkeys: [1, 0] });
  });

  it('auth:prune-tokens skips an app without users of its own, says so, and prunes every guard', async () => {
    const { run, lines, tables } = await boot({ appUsers: 'none' });
    expect(await run(PruneTokensCommand, [], {})).toBe(0);
    expect(lines).toEqual(['Skipped the app: it has no users of its own (no UserProvider is bound).', "Pruned 1 password reset token and 1 sign-in of the guard 'office'."]);
    expect((await tables()).resets).toEqual([1, 0]);
  });

  it("auth:prune-tokens judges a guard's rows by the guard's settings, and the app's by the app's", async () => {
    // Ninety minutes on: past the app's reset time (60 minutes) and sign-in maximum (1 hour), inside the guard's (a day).
    const longGuard = await boot({ appEnv: { AUTH_RESET_MINUTES: '60', AUTH_SESSION_MAX_HOURS: '1' }, settings: { resetMinutes: 1440, sessionMaxHours: 24 }, travel: { minutes: 90 } });
    expect(await longGuard.run(PruneTokensCommand, [], {})).toBe(0);
    expect(await longGuard.tables()).toEqual({ ...KEPT, resets: [0, 1], signIns: [0, 1] });

    const shortGuard = await boot({ appEnv: { AUTH_RESET_MINUTES: '1440', AUTH_SESSION_MAX_HOURS: '24' }, settings: { resetMinutes: 10, sessionMaxHours: 1 }, travel: { minutes: 90 } });
    expect(await shortGuard.run(PruneTokensCommand, [], {})).toBe(0);
    expect(await shortGuard.tables()).toEqual({ ...KEPT, resets: [1, 0], signIns: [1, 0] });
  });

  it("auth:prune-tokens judges a guard's remember-me tokens by the guard's rememberDays, and the app's by the app's", async () => {
    // Two days on, ten-day tokens: a one-day limit takes the token off its sign-in, which is over then; a thirty-day limit leaves both.
    const shortGuard = await boot({ remember: true, appEnv: { AUTH_REMEMBER_DAYS: '30' }, settings: { rememberDays: 1 } });
    expect(await shortGuard.run(PruneTokensCommand, [], {})).toBe(0);
    expect((await shortGuard.tables()).signIns).toEqual([1, 0]);

    const shortApp = await boot({ remember: true, appEnv: { AUTH_REMEMBER_DAYS: '1' }, settings: { rememberDays: 5 } });
    expect(await shortApp.run(PruneTokensCommand, [], {})).toBe(0);
    expect((await shortApp.tables()).signIns).toEqual([0, 1]);
  });

  it('auth:prune-tokens does not skip an app without guards that has no users of its own', async () => {
    const container = await bootWithoutGuards();
    const lines: string[] = [];
    const output = { line: (line: string) => lines.push(line), success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const command = container.createScope().make(PruneTokensCommand as never) as { handle(input: never): Promise<number> };
    expect(await command.handle({ args: [], options: {}, output, root: '/', spawn: async () => 0 } as never)).toBe(0);
    expect(lines).toEqual(['Pruned 0 password reset tokens, 0 API tokens and 0 sign-ins.']);
  });

  it('auth:end-all-sessions in an app without users of its own refuses a guard, and builds', async () => {
    const { run, lines, tables } = await boot({ appUsers: 'none' });
    expect(await run(EndAllSessionsCommand, [], { force: true, guard: 'office' })).toBe(1);
    expect(await run(EndAllSessionsCommand, [], { force: true, guard: 'nope' })).toBe(1);
    expect(lines).toEqual([
      "✗ auth:end-all-sessions ends the sessions of the app's accounts and is not available for the guard 'office'. To sign out one account of the guard, use auth:end-sessions <identifier> --guard=office --force. Nothing was ended.",
      UNKNOWN,
    ]);
    expect(await tables()).toEqual(KEPT);
  });

  it('logs the guard next to the account for auth:reset-two-factor --guard=office', async () => {
    const { run, infos } = await boot();
    expect(await run(ResetTwoFactorCommand, ['ada@example.com'], { force: true, guard: 'office' })).toBe(0);
    expect(infos).toEqual([["Removed the second factor of an account at the operator's request", { userId: 1, guard: 'office' }]]);
  });

  it('a hand-built auth:prune-tokens has no guards to name and refuses --guard=office, pruning nothing', async () => {
    let pruned = 0;
    const store = { prune: async () => (pruned++, 0) } as never;
    const lines: string[] = [];
    const output = { line: (line: string) => lines.push(line), success: (line: string) => lines.push(line), error: (line: string) => lines.push(`✗ ${line}`) };
    const command = new PruneTokensCommand(store, store, { resetMinutes: 60, rememberDays: 30, sessionMaxSeconds: 86_400 } as never, { lifetimeMinutes: 120 } as never, store);
    expect(await command.handle({ args: [], options: { guard: 'office' }, output, root: '/', spawn: async () => 0 } as never)).toBe(1);
    expect(lines).toEqual(['✗ No guard is named "office". The guards are: web.']);
    expect(pruned).toBe(0);
  });
});
