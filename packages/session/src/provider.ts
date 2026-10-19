import { isAbsolute, join } from 'node:path';
import { Application, Clock, Logger, Redactor, type Container, type Resolver, type ServiceProvider } from '@marmeon/core';
import { Encrypter } from '@marmeon/encryption';
import { CookieDefaults, CookieEncryption, Flasher, PageSession } from '@marmeon/http';
import { MiddlewarePriority, Router } from '@marmeon/router';
import { EncryptedSessionCodec, plainSessionCodec, SessionCodec } from './codec.ts';
import { insecureCookieWarning, SessionConfig, sessionCookieName } from './config.ts';
import { CsrfConfig, CsrfProtection, VerifyCsrfToken, XSRF_COOKIE } from './csrf.ts';
import { Session } from './session.ts';
import { sessionScope, SessionEndings } from './ended.ts';
import { ShareErrorsFromSession } from './share-errors.ts';
import { SessionLottery, StartSession } from './start-session.ts';
import { MakeSessionTableCommand } from './commands/make-session-table.ts';
import { PruneSessionsCommand } from './commands/prune-sessions.ts';
import { SESSION_USER_KEY, SessionStore } from './store.ts';
import { UserSessions } from './user-sessions.ts';
import { DatabaseSessionStore, SESSIONS_COLUMNS, SESSIONS_TABLE } from './stores/database.ts';
import { FileSessionStore } from './stores/file.ts';
import { MemorySessionStore } from './stores/memory.ts';
import { RedisSessionStore } from './stores/redis.ts';
import { withCode } from '@marmeon/core/internal';

declare module '@marmeon/core' {
  interface ModuleDefinition {
    /** Paths of this module that skip CSRF verification, e.g. webhooks: `['/webhooks/*']`. */
    readonly csrfExcept?: readonly string[];
  }
}

/**
 * Registers the session and its store (`SESSION_DRIVER`), and adds StartSession
 * and VerifyCsrfToken to the `web` group. Found by `marmeon discover`.
 */
export class SessionServiceProvider implements ServiceProvider {
  static config = [SessionConfig, CsrfConfig];
  static commands = [MakeSessionTableCommand, PruneSessionsCommand];

  register(container: Container): void {
    container.singleton(CsrfProtection);
    container.singleton(SessionEndings);
    container.scoped(Session);
    // `redirect().with(…)` flashes into the request's session.
    container.scoped(Flasher, (c) => c.make(Session));
    // What a page knows of the session: the CSRF token for forms without JavaScript, and a scope for once props.
    container.scoped(PageSession, (c) => pageSessionOf(c.make(Session)));

    const config = container.make(SessionConfig);
    // Every cookie of a request gets `Secure` with the session's — the reset cookie, an app's own —
    // unless its `set` says otherwise.
    container.instance(CookieDefaults, { secure: config.secure });
    container.singleton(SessionLottery, () => new SessionLottery(config.lottery));
    container.singleton(SessionCodec, (c) => (config.encrypt ? new EncryptedSessionCodec(c.make(Encrypter)) : plainSessionCodec));
    container.singleton(SessionStore, (c) => storeFor(config, c));
    // A user's sessions as a whole (a deleted account's) — the shared store's.
    container.singleton(UserSessions, (c) => new UserSessions(() => c.make(SessionStore), c.make(SessionEndings)));
  }

  async boot(app: Application): Promise<void> {
    app.container
      .make(Router)
      .middleware.append('web', StartSession, MiddlewarePriority.startSession)
      .append('web', VerifyCsrfToken, MiddlewarePriority.verifyCsrfToken)
      .append('web', ShareErrorsFromSession, MiddlewarePriority.shareProps);
    app.container.make(CookieEncryption).except(XSRF_COOKIE); // the browser's JavaScript reads it
    // The session cookie's value is the session — never shown or recorded, whatever its name.
    if (app.container.has(Redactor)) app.container.make(Redactor).addKeys(sessionCookieName(app.container.make(SessionConfig)));
    app.container.make(CsrfProtection).except(...app.modules.flatMap((module) => module.csrfExcept ?? []));

    // A driver whose package is missing fails the start with what to install — not the first request with a stack trace.
    const { driver, connection, secure, secureFrom } = app.container.make(SessionConfig);
    // Protected (production, no NODE_ENV) and cookies without Secure: said once, at boot.
    if (app.container.make(SessionConfig).protected && !secure) app.container.make(Logger).warn(insecureCookieWarning(secureFrom), { secureFrom });
    if (driver === 'redis') {
      const redis = await importRedis();
      if (!app.container.has(redis.RedisConnections)) {
        throw new SessionSetupError(withCode('A3', 'SESSION_DRIVER=redis needs the RedisServiceProvider of @marmeon/redis (installed packages register it: marmeon discover).'));
      }
      const connections = app.container.make(redis.RedisConnections);
      connections.options(connection);
      await connections.verify();
    } else if (driver === 'database') {
      const database = await importDatabase();
      if (!app.container.has(database.Connections)) {
        throw new SessionSetupError(withCode('A3', 'SESSION_DRIVER=database needs the DatabaseServiceProvider of @marmeon/database (installed packages register it: marmeon discover).'));
      }
      app.container.make(database.Connections).options(connection);
      // /up/ready is red until the table has the new name and every column the store writes.
      const { SchemaRequirements } = await import('@marmeon/database');
      app.container.make(SchemaRequirements).require({ connection, table: SESSIONS_TABLE, columns: SESSIONS_COLUMNS, secrets: ['payload'], set: 'session' });
    }

    // The scheduler runs `marmeon session:prune`: then it is the one sweeper, and requests no longer draw the lottery.
    const scheduler = await import('@marmeon/scheduler').catch(() => undefined);
    if (scheduler && app.container.has(scheduler.Scheduler) && app.container.make(scheduler.Scheduler).schedules(PruneSessionsCommand.command)) {
      app.container.make(SessionLottery).chance = 0;
    }
  }
}

/** A driver's package is missing: what to install, said at startup (the CLI prints it without a stack trace). */
export class SessionSetupError extends Error {
  override name = 'SessionSetupError';
}

async function importOptional<T>(load: () => Promise<T>, name: string, driver: string, install: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
    if (code === 'ERR_MODULE_NOT_FOUND' && typeof message === 'string' && message.includes(name)) {
      throw new SessionSetupError(withCode('A3', `SESSION_DRIVER=${driver} needs ${name}, which is not installed in this app: ${install}`));
    }
    throw error;
  }
}

/** For messages of the database: who uses its infrastructure connection, and what to do on a shared SQLite file. */
const SESSION_INFRASTRUCTURE = {
  system: 'The session store (SESSION_DRIVER=database)',
  remedy:
    "Give the sessions their own SQLite file — a connection like defineConnection('system', …) for storage/system.sqlite, SESSION_CONNECTION=system, " +
    'and `marmeon migrate` (the migration of `marmeon make:session-table` follows SESSION_CONNECTION) — or use Redis (SESSION_DRIVER=redis).',
};

/**
 * The connection the `sessions` table belongs on — for the migration `marmeon make:session-table` writes (`connection` in
 * `defineMigration`): `SESSION_CONNECTION` with the database driver, else `default`.
 */
export function sessionTableConnection(container: Resolver): string {
  const config = container.make(SessionConfig);
  return config.driver === 'database' ? config.connection : 'default';
}

const importDatabase = () => importOptional(() => import('@marmeon/database'), '@marmeon/database', 'database', 'pnpm add @marmeon/database');
const importRedis = () => importOptional(() => import('@marmeon/redis'), '@marmeon/redis', 'redis', 'pnpm add @marmeon/redis');

/** The store of `SESSION_DRIVER`. Database and Redis connections are looked up on first use, through their packages. */
function storeFor(config: SessionConfig, container: Resolver): SessionStore {
  const clock = container.make(Clock);
  const lifetime = config.lifetime * 60;
  switch (config.driver) {
    case 'memory':
      return new MemorySessionStore(clock);
    case 'database':
      // Its own connection, never the app's transaction: a session written inside one survives its rollback.
      return new DatabaseSessionStore(
        async () => ({ db: container.make((await importDatabase()).Connections).infrastructure(config.connection, SESSION_INFRASTRUCTURE) }),
        lifetime,
        clock,
      );
    case 'redis':
      return new RedisSessionStore(async () => container.make((await importRedis()).RedisConnections).get(config.connection));
    case 'file': {
      const { root } = container.make(Application);
      return new FileSessionStore(isAbsolute(config.files) ? config.files : join(root, config.files), clock);
    }
  }
}

/**
 * The session as a page sees it: the CSRF token of a session that is kept. The scope is a hash of the session id —
 * never the id, which is a secret — so it changes with every sign-in and sign-out (the id is regenerated) and tells nothing about
 * the session it came from.
 */
export function pageSessionOf(session: Session): PageSession {
  const started = <T>(read: () => T): T | undefined => {
    try {
      return read();
    } catch {
      return undefined; // not started (no session on this request)
    }
  };
  return {
    // Only a session that is kept has a token worth putting into the page: a guest's new session, with nothing in it,
    // gets none — and is not kept just for it. Its forms pass by the browser's word (Fetch Metadata, Origin).
    // Made now if the session has none yet — but never by a read-only request (an island): a token it made would never be
    // saved; it gives the one the session has, if any.
    csrfToken: () => started(() => (!session.exists ? undefined : session.readOnly ? session.currentToken() : session.token())),
    scope: (options) => {
      // A session that is not kept has an id nobody will see again: no scope — unless the caller binds something to it.
      const id = started(() => {
        if (options?.keep && !session.readOnly) session.persist();
        return session.exists ? session.id : undefined;
      });
      return id ? sessionScope(id) : undefined;
    },
    // The tab-sync epoch's part: a signed-in user's session — its scope (new with every regenerated id) and the user's id.
    // A guest's is none: their session (a failed login's flash data) does not make the other tabs reload.
    generation: () =>
      started(() => {
        const user: unknown = session.get(SESSION_USER_KEY);
        return typeof user === 'string' || typeof user === 'number' || typeof user === 'bigint' ? `${sessionScope(session.id)}\n${String(user)}` : undefined;
      }),
  };
}
