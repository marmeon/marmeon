import { defineRoutes, everyone } from '@marmeon/http';
import { LocalOidcHost } from './LocalOidcHost.ts';
import { LocalOidcTokenController } from './controllers/LocalOidcController.ts';

// Loaded into the stateless `api` group under /api — no cookies, no session, no CSRF: the app's server calls it with the client secret. The
// token endpoint of the local OpenID Connect provider: 403 for a host other than the app's own (`LocalOidcHost`), and 404 outside development and test (`LocalOidc.provider()`).
export default defineRoutes((Route) => {
  Route.prefix('/_dev/oidc').middleware(LocalOidcHost).authorize(everyone).post('/token', LocalOidcTokenController);
});
