import { guest } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { OAuthCallbackController } from './controllers/OAuthCallbackController.ts';
import { OAuthRedirectController } from './controllers/OAuthRedirectController.ts';
import { ShowSignInButtonsController } from './controllers/ShowSignInButtonsController.ts';
import { TARGETS } from './targets.ts';

// Loaded into the `web` middleware group: encrypted cookies and the session come with it. A provider name is lower case letters, digits and
// dashes; a path that does not look like one is a 404 before any controller runs.
const PROVIDER = ':provider{[a-z][a-z0-9-]*}';

export default defineRoutes((Route) => {
  // Decided for the start and the island: signing in is for people who are not signed in yet, and `guest()` turns signed-in people away.
  const guests = Route.middleware(guest({ homeRoute: TARGETS.home })).authorize(everyone);
  // The buttons — an island, which a page of yours places with `<Island route="oauth.sign-in" />`.
  guests.get('/oauth/sign-in', ShowSignInButtonsController).name('oauth.sign-in');
  // A POST only: a GET that opened a flow could be made by any page that links to it.
  guests.middleware(throttle('oauth.redirect')).post(`/auth/${PROVIDER}/redirect`, OAuthRedirectController).name('oauth.redirect');

  // Not behind `guest()` or `authenticate()`: the provider sends the browser back here, and this route also completes the flows of a
  // signed-in person (linking an account, confirming one), which `guest()` would turn away before the flow is spent. The flow itself is
  // bound to whoever started it, and the callback passes the signed-in user, so a flow never serves another person. One callback per
  // session at a time (block()): two that arrive together could both take the same flow out of the session before either spends it.
  Route.middleware(throttle('oauth.callback'))
    .authorize(everyone)
    .get(`/auth/${PROVIDER}/callback`, OAuthCallbackController)
    .name('oauth.callback')
    .block({ lock: { minutes: 1 }, wait: { seconds: 10 } });
});
