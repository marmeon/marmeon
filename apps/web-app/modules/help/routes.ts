import { defineRoutes, everyone } from '@marmeon/http';
import { ShowHelpPageController } from './controllers/ShowHelpPageController.ts';

export default defineRoutes((Route) => {
  // `fallback()` answers every GET path below `/help` that no route takes, whatever order the modules load in: the `support`
  // module loads after this one and still owns `/help/contact`. `/help/accounts/passkeys` gives `accounts/passkeys`, `/help` gives ''.
  // The router has checked the path segment by segment (no empty segment, no encoded `/`), so the controller only looks it up.
  Route.authorize(everyone).prefix('/help').name('help.').fallback(ShowHelpPageController).name('page').sitemap();
});
