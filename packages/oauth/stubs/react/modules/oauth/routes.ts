import { authenticate, guest, verified } from '@marmeon/auth';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone } from '@marmeon/http';
import { OAuthCallbackController } from './controllers/OAuthCallbackController.ts';
import { ConfirmWithProviderController } from './controllers/ConfirmWithProviderController.ts';
import { LinkSocialAccountController } from './controllers/LinkSocialAccountController.ts';
import { OAuthRedirectController } from './controllers/OAuthRedirectController.ts';
import { ShowConfirmButtonsController } from './controllers/ShowConfirmButtonsController.ts';
import { ShowConnectedAccountsController } from './controllers/ShowConnectedAccountsController.ts';
import { ShowSignInButtonsController } from './controllers/ShowSignInButtonsController.ts';
import { UnlinkSocialAccountController } from './controllers/UnlinkSocialAccountController.ts';
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

  // Decided for the panel: only signed-in people manage their accounts. Linking and unlinking carry no `confirmedPassword()`, on purpose: the
  // confirmation can come from a provider as well as from a password (an account without a password has none to type), and `SocialAccounts`
  // checks it itself, on its own side, whatever the route says.
  const account = Route.middleware(authenticate()).authorize(everyone);
  // The panel — an island, which a settings page of yours places with `<Island route="oauth.accounts" />`.
  account.get('/oauth/accounts', ShowConnectedAccountsController).name('oauth.accounts');
  // A POST only, like the sign-in's start. Only an account whose address is confirmed links one; `SocialAccounts` checks that too.
  account.middleware(verified()).middleware(throttle('oauth.link')).post(`/oauth/accounts/${PROVIDER}`, LinkSocialAccountController).name('oauth.link');
  // One removal per session at a time (block()): two that arrive together could each see another way in that the other takes away.
  account.post(`/oauth/accounts/${PROVIDER}/remove`, UnlinkSocialAccountController).name('oauth.unlink').block();
  // Confirming with a provider: the buttons for the confirmation page of your app, and the start of the round trip.
  account.get('/oauth/confirm', ShowConfirmButtonsController).name('oauth.confirm-options');
  account.middleware(throttle('oauth.confirm')).post(`/oauth/confirm/${PROVIDER}`, ConfirmWithProviderController).name('oauth.confirm');

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
