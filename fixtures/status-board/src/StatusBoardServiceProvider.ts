import { authenticate } from '@marmeon/auth';
import type { Container, ServiceProvider } from '@marmeon/core';
import { contentSecurityPolicy, defineRoutes, describeAccess, NONCE, Router } from '@marmeon/http';
import { ShowStatusController } from './ShowStatusController.ts';
import { StatusAccess } from './StatusAccess.ts';
import { StatusBoardConfig } from './StatusBoardConfig.ts';

/** Registers the area: its routes below `STATUS_BOARD_PATH`, behind a sign-in and the app's {@link StatusAccess}. */
export class StatusBoardServiceProvider implements ServiceProvider {
  static config = [StatusBoardConfig];

  register(container: Container): void {
    const { path } = container.make(StatusBoardConfig);
    // The area's document gets this policy, not the app's: nothing but its own origin may load or be connected to.
    const policy = contentSecurityPolicy({ styleSrc: ["'self'", NONCE], imgSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"] });
    container.make(Router).load(
      { group: 'web', prefix: path },
      defineRoutes((Route) => {
        // A user the app has not admitted is refused, and so is every user while the app binds no access: the check asks at request time.
        Route.middleware(policy)
          .middleware(authenticate())
          .authorize(describeAccess(async (ctx) => (container.has(StatusAccess) ? await container.make(StatusAccess).allows(ctx.user) : false), 'status access'))
          .get('/', ShowStatusController)
          .name('status.index');
      }),
    );
  }
}
