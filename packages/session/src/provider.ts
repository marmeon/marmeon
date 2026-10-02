import { createHash } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { Application, type Container, type ServiceProvider } from '@bespokecore/core';
import { CookieEncryption, Flasher, PageSession } from '@bespokecore/http';
import { CookieJar, MiddlewarePriority, Router } from '@bespokecore/router';
import { SessionConfig } from './config.ts';
import { CsrfConfig, CsrfProtection, VerifyCsrfToken, XSRF_COOKIE } from './csrf.ts';
import { Session } from './session.ts';
import { ShareErrorsFromSession } from './share-errors.ts';
import { StartSession } from './start-session.ts';
import { CookieSessionStore, FileSessionStore, MemorySessionStore, SessionStore } from './store.ts';

declare module '@bespokecore/core' {
  interface ModuleDefinition {
    /** Paths of this module that skip CSRF verification, e.g. webhooks: `['/webhooks/*']`. */
    readonly csrfExcept?: readonly string[];
  }
}

/**
 * Registers the session and its store (`SESSION_DRIVER`), and adds StartSession
 * and VerifyCsrfToken to the `web` group. Found by `bespoke discover`.
 */
export class SessionServiceProvider implements ServiceProvider {
  static config = [SessionConfig, CsrfConfig];

  register(container: Container): void {
    container.singleton(CsrfProtection);
    container.scoped(Session);
    // `redirect().with(…)` flashes into the request's session.
    container.scoped(Flasher, (c) => c.make(Session));
    // What a page knows of the session (E64): the CSRF token for forms without JavaScript, and a scope for once props.
    container.scoped(PageSession, (c) => pageSessionOf(c.make(Session)));

    const config = container.make(SessionConfig);
    switch (config.driver) {
      case 'memory':
        container.singleton(SessionStore, () => new MemorySessionStore());
        break;
      case 'file':
        container.singleton(SessionStore, (c) => {
          const { root } = c.make(Application);
          return new FileSessionStore(isAbsolute(config.files) ? config.files : join(root, config.files));
        });
        break;
      case 'cookie':
        container.scoped(SessionStore, (c) => new CookieSessionStore(c.make(CookieJar), config.cookie));
        break;
    }
  }

  boot(app: Application): void {
    app.container
      .make(Router)
      .middleware.append('web', StartSession, MiddlewarePriority.startSession)
      .append('web', VerifyCsrfToken, MiddlewarePriority.verifyCsrfToken)
      .append('web', ShareErrorsFromSession, MiddlewarePriority.shareProps);
    app.container.make(CookieEncryption).except(XSRF_COOKIE); // the browser's JavaScript reads it
    app.container.make(CsrfProtection).except(...app.modules.flatMap((module) => module.csrfExcept ?? []));
  }
}

/**
 * The session as a page sees it (E64). The scope is a hash of the session id — never the id, which is a secret — so it changes
 * with every sign-in and sign-out (the id is regenerated) and tells nothing about the session it came from.
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
    csrfToken: () => started(() => session.token()),
    scope: () => {
      const id = started(() => session.id);
      return id ? createHash('sha256').update(`bespoke-once-scope:${id}`).digest('base64url').slice(0, 22) : undefined;
    },
  };
}
