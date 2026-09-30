import { isAbsolute, join } from 'node:path';
import { Application, type Container, type ServiceProvider } from '@bespokecore/core';
import { Flasher } from '@bespokecore/http';
import { CookieJar } from '@bespokecore/router';
import { SessionConfig } from './config.ts';
import { Session } from './session.ts';
import { CookieSessionStore, FileSessionStore, MemorySessionStore, SessionStore } from './store.ts';

/** Registers the session and its store (`SESSION_DRIVER`). Found by `bespoke discover`. */
export class SessionServiceProvider implements ServiceProvider {
  static config = [SessionConfig];

  register(container: Container): void {
    container.scoped(Session);
    // `redirect().with(…)` flashes into the request's session.
    container.scoped(Flasher, (c) => c.make(Session));

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
}
