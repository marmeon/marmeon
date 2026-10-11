import { resolve } from 'node:path';
import { Application, type Container, type ServiceProvider } from '@marmeon/core';
import { LegalPages } from './LegalPages.ts';

/** Reads the legal pages while the app boots (a missing file stops the start); their routes are in `routes.ts` with the landing's. */
export class LegalServiceProvider implements ServiceProvider {
  register(container: Container): void {
    container.singleton(LegalPages, (c) => new LegalPages(resolve(c.make(Application).root, 'content/legal')));
  }

  boot(app: Application): void {
    app.container.make(LegalPages).load();
  }
}
