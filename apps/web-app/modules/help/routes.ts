import { defineRoutes, everyone } from '@marmeon/http';
import { ShowHelpPageController } from './controllers/ShowHelpPageController.ts';

export default defineRoutes((Route) => {
  // `localized().fallback()` answers every GET path below `/en/help` and `/de/help` that no route takes, whatever order the modules
  // load in: the `support` module loads after this one and still owns `/en/help/contact`. `/de/help/accounts/passkeys` gives
  // `accounts/passkeys` and the locale `de`, `/de/help` gives ''. `/help/…` without a language redirects to the visitor's.
  // The router has checked the path segment by segment (no empty segment, no encoded `/`), so the controller only looks it up.
  Route.localized().authorize(everyone).prefix('/help').name('help.').fallback(ShowHelpPageController).name('page').sitemap();
});
