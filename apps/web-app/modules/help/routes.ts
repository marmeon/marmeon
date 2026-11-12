import { defineRoutes, everyone } from '@marmeon/http';
import { ShowHelpPageController } from './controllers/ShowHelpPageController.ts';

export default defineRoutes((Route) => {
  // `/:path*` takes the rest of the path as one value — `/help/accounts/passkeys` gives `accounts/passkeys`, `/help` gives ''.
  // The router has checked it segment by segment (no empty segment, no encoded `/`), so the controller only looks it up.
  Route.authorize(everyone).prefix('/help').name('help.').get('/:path*', ShowHelpPageController).name('page');
});
