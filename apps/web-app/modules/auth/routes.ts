import { authenticate, confirmedPassword, guest } from '@marmeon/auth';
import { confirmedSecondFactor, twoFactor } from '@marmeon/auth/two-factor';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone, signed } from '@marmeon/http';
import { ConfirmEmailChangeController } from './controllers/ConfirmEmailChangeController.ts';
import { ConfirmPasswordController } from './controllers/ConfirmPasswordController.ts';
import { CreateAccessTokenController, ShowCreateAccessTokenController } from './controllers/CreateAccessTokenController.ts';
import { BeginTwoFactorController } from './controllers/BeginTwoFactorController.ts';
import { ConfirmTwoFactorController } from './controllers/ConfirmTwoFactorController.ts';
import { EndSignInController } from './controllers/EndSignInController.ts';
import { DisableTwoFactorController } from './controllers/DisableTwoFactorController.ts';
import { LoginController } from './controllers/LoginController.ts';
import { PasskeyChallengeController } from './controllers/PasskeyChallengeController.ts';
import { PasskeyChallengeOptionsController } from './controllers/PasskeyChallengeOptionsController.ts';
import { PasskeyRegistrationOptionsController } from './controllers/PasskeyRegistrationOptionsController.ts';
import { PasskeyConfirmController } from './controllers/PasskeyConfirmController.ts';
import { PasskeyConfirmOptionsController } from './controllers/PasskeyConfirmOptionsController.ts';
import { PasskeyStepUpController } from './controllers/PasskeyStepUpController.ts';
import { PasskeyStepUpOptionsController } from './controllers/PasskeyStepUpOptionsController.ts';
import { PasskeySignInController } from './controllers/PasskeySignInController.ts';
import { PasskeySignInOptionsController } from './controllers/PasskeySignInOptionsController.ts';
import { LogoutController } from './controllers/LogoutController.ts';
import { LogoutOtherDevicesController } from './controllers/LogoutOtherDevicesController.ts';
import { RedirectToTwoFactorController } from './controllers/RedirectToTwoFactorController.ts';
import { ReleasePasskeyController } from './controllers/ReleasePasskeyController.ts';
import { RegisterPasskeyController } from './controllers/RegisterPasskeyController.ts';
import { RemovePasskeyController } from './controllers/RemovePasskeyController.ts';
import { RenamePasskeyController } from './controllers/RenamePasskeyController.ts';
import { ShowPasskeysController } from './controllers/ShowPasskeysController.ts';
import { RegenerateRecoveryCodesController } from './controllers/RegenerateRecoveryCodesController.ts';
import { RegisterController } from './controllers/RegisterController.ts';
import { ResendVerificationController } from './controllers/ResendVerificationController.ts';
import { ResetPasswordController } from './controllers/ResetPasswordController.ts';
import { RevokeAccessTokenController } from './controllers/RevokeAccessTokenController.ts';
import { ShowAccessTokensController } from './controllers/ShowAccessTokensController.ts';
import { SendPasswordResetLinkController } from './controllers/SendPasswordResetLinkController.ts';
import { ShowForgotPasswordController } from './controllers/ShowForgotPasswordController.ts';
import { ShowResetPasswordController } from './controllers/ShowResetPasswordController.ts';
import { ShowConfirmPasswordController } from './controllers/ShowConfirmPasswordController.ts';
import { ShowLoginController } from './controllers/ShowLoginController.ts';
import { ShowRegisterController } from './controllers/ShowRegisterController.ts';
import { ShowRegistrationSentController } from './controllers/ShowRegistrationSentController.ts';
import { ShowSecurityController } from './controllers/ShowSecurityController.ts';
import { ShowTwoFactorChallengeController } from './controllers/ShowTwoFactorChallengeController.ts';
import { ShowSensitiveController } from './controllers/ShowSensitiveController.ts';
import { ShowTwoFactorController } from './controllers/ShowTwoFactorController.ts';
import { ShowTwoFactorVerifyController } from './controllers/ShowTwoFactorVerifyController.ts';
import { TwoFactorChallengeController } from './controllers/TwoFactorChallengeController.ts';
import { TwoFactorVerifyController } from './controllers/TwoFactorVerifyController.ts';
import { ShowVerifyEmailNoticeController } from './controllers/ShowVerifyEmailNoticeController.ts';
import { UpdateEmailController } from './controllers/UpdateEmailController.ts';
import { UpdatePasswordController } from './controllers/UpdatePasswordController.ts';
import { VerifyEmailController } from './controllers/VerifyEmailController.ts';
import { ConfirmedAddress } from './middleware/ConfirmedAddress.ts';

// Loaded into the `web` middleware group: encrypted cookies and the session come with it.
export default defineRoutes((Route) => {
  // Guests only: signed-in people go to their profile.
  // Decided for this module's own routes only: signing in and signing up are for people who are not signed in yet, and `guest()` turns
  // signed-in people away. A route you add needs its own decision.
  const guests = Route.middleware(guest('/users/me')).authorize(everyone);
  guests.get('/', ShowLoginController);
  guests.get('/login', ShowLoginController).name('auth.login');
  guests.middleware(throttle('login-client')).post('/login', LoginController).name('auth.login.store');
  // The second step of signing in: a correct password waits here for the code (a guest still — nobody is signed in yet). One
  // request per session at a time (block()): two codes at once could not both be counted.
  guests.get('/two-factor-challenge', ShowTwoFactorChallengeController).name('auth.two-factor.challenge');
  guests.post('/two-factor-challenge', TwoFactorChallengeController).name('auth.two-factor.challenge.store').block();
  // Passkeys, the browser's way in: sign in with one alone, or prove one after the password. JSON in and out; the session's one challenge
  // is opened by the options and spent by the answer, one request per session at a time (block()). Failures are throttled per address
  // and account inside `Passkeys`; the options only get a loose limit against load.
  guests.middleware(throttle('passkey-options')).post('/passkeys/sign-in/options', PasskeySignInOptionsController).name('auth.passkeys.sign-in.options');
  guests.post('/passkeys/sign-in', PasskeySignInController).name('auth.passkeys.sign-in').block();
  guests.middleware(throttle('passkey-challenge-options')).post('/two-factor-challenge/passkey/options', PasskeyChallengeOptionsController).name('auth.passkeys.challenge.options');
  guests.post('/two-factor-challenge/passkey', PasskeyChallengeController).name('auth.passkeys.challenge').block();
  guests.get('/register', ShowRegisterController).name('auth.register');
  // A few sign-ups per minute and address — live validation of the form does not count.
  guests.middleware(throttle('register')).post('/register', RegisterController).name('auth.register.store');
  // Private registration (the default): every sign-up ends here — a new address and a known one alike (404 with
  // AUTH_PRIVATE_REGISTRATION=false: a sign-up signs in then).
  guests.get('/register/sent', ShowRegistrationSentController).name('auth.register.sent');
  guests.get('/forgot-password', ShowForgotPasswordController).name('auth.password.request');
  guests.middleware(throttle('password-reset')).post('/forgot-password', SendPasswordResetLinkController).name('auth.password.email');
  guests.get('/reset-password', ShowResetPasswordController).name('auth.password.reset');
  guests.post('/reset-password', ResetPasswordController).name('auth.password.store');

  // Decided for this module's own routes only: each concerns the signed-in user's own account, and the ids in the paths (passkeys,
  // tokens, verification links) are looked up within `ctx.user` or bound by a signature. A route you add needs its own decision:
  // build it on `Route.middleware(authenticate())`, not on this registrar or the ones derived from it.
  const account = Route.middleware(authenticate()).authorize(everyone);
  account.post('/logout', LogoutController).name('auth.logout');
  // Private registration (the default): the app is for confirmed addresses only — whoever signed up with somebody else's
  // address (it was free then) signs in, but sees nothing but the notice until the link from that inbox is clicked while signed
  // in. With AUTH_PRIVATE_REGISTRATION=false the settings stay open to an unconfirmed address (a typo in a new address can be
  // fixed); the other modules ask for a confirmed one either way (`verified()`).
  const confirmed = account.middleware(ConfirmedAddress);
  confirmed.get('/confirm-password', ShowConfirmPasswordController).name('auth.password.confirm');
  confirmed.post('/confirm-password', ConfirmPasswordController).name('auth.password.confirm.store');
  // Confirming with a passkey: the options open a challenge per call, so they are limited per user.
  confirmed.middleware(throttle('passkey-confirm-options')).post('/confirm-password/passkey/options', PasskeyConfirmOptionsController).name('auth.password.confirm.passkey.options');
  confirmed.post('/confirm-password/passkey', PasskeyConfirmController).name('auth.password.confirm.passkey').block();
  // "Sudo mode": the security page asks for the password again unless a password or a passkey confirmed it within 15 minutes.
  confirmed.middleware(confirmedPassword()).get('/settings/security', ShowSecurityController).name('auth.security');
  // A new hash in the database and its fingerprint in the session must stay a pair: one of these requests per session at a
  // time (block()) — two at once could leave the session with the other's fingerprint, and sign it out.
  confirmed.put('/settings/password', UpdatePasswordController).name('auth.password.update').block();
  confirmed.post('/settings/devices/logout', LogoutOtherDevicesController).name('auth.devices.logout').block();
  // Private registration: a new address is pending until the link sent to it is clicked — the same answer for every
  // address; a few requests a minute per user (each one sends a mail somewhere). With AUTH_PRIVATE_REGISTRATION=false it changes at once.
  confirmed.middleware(confirmedPassword()).middleware(confirmedSecondFactor({ verify: 'auth.two-factor.verify' })).middleware(throttle('email-change')).put('/settings/email', UpdateEmailController).name('auth.email.update');
  // API tokens: as good as a session — sudo mode for all of it.
  const sudo = confirmed.middleware(confirmedPassword());
  // Changing the factors takes a factor proven within 15 minutes as well, where the account has one: the password alone, with a session
  // that is older than that, must not add a factor of its own or take one away. An account without a factor passes — its first one needs
  // only the password — which keeps the setup page reachable. Confirming a setup is left out, like the sudo mode.
  const factors = sudo.middleware(confirmedSecondFactor({ verify: 'auth.two-factor.verify' }));
  // The second factor: sudo mode for all of it; turning it off asks for the password again.
  factors.get('/settings/two-factor', ShowTwoFactorController).name('auth.two-factor');
  factors.post('/settings/two-factor/setup', BeginTwoFactorController).name('auth.two-factor.begin');
  // Confirming needs a signed-in user and the throttle, not sudo mode: the code of a setup that took a while to scan must not be lost.
  confirmed.post('/settings/two-factor/confirm', ConfirmTwoFactorController).name('auth.two-factor.confirm');
  factors.post('/settings/two-factor/recovery-codes', RegenerateRecoveryCodesController).name('auth.two-factor.codes');
  // The recovery codes are layers that answer these POSTs, shown once; Forward asks their URLs with a GET (the settings page).
  confirmed.get('/settings/two-factor/confirm', RedirectToTwoFactorController);
  confirmed.get('/settings/two-factor/recovery-codes', RedirectToTwoFactorController);
  factors.post('/settings/two-factor/disable', DisableTwoFactorController).name('auth.two-factor.disable');
  // Proving the factor again in this session (where `twoFactor()` sends a session that has not): a wrong code ends nothing. One request
  // per session at a time (block()), as at the sign-in.
  confirmed.get('/settings/two-factor/verify', ShowTwoFactorVerifyController).name('auth.two-factor.verify');
  confirmed.post('/settings/two-factor/verify', TwoFactorVerifyController).name('auth.two-factor.verify.store').block();
  // The same with a passkey: the options open a challenge, so they have a limit of their own (per user); the check is throttled per account inside `TwoFactor`.
  confirmed.middleware(throttle('passkey-step-up-options')).post('/settings/two-factor/verify/passkey/options', PasskeyStepUpOptionsController).name('auth.passkeys.step-up.options');
  confirmed.post('/settings/two-factor/verify/passkey', PasskeyStepUpController).name('auth.passkeys.step-up').block();
  // Only for sessions that proved a second factor within 15 minutes — an example of `twoFactor()`. An app chooses where to put it; nothing else
  // here requires a factor, and the framework never installs it by itself.
  confirmed.middleware(twoFactor({ setup: 'auth.two-factor', verify: 'auth.two-factor.verify', maxAge: 900 })).get('/settings/sensitive', ShowSensitiveController).name('auth.sensitive');
  // Passkeys: sudo mode and a recently proven factor for all of it but renaming; adding one asks for the password again, removing the last factor too.
  factors.get('/settings/passkeys', ShowPasskeysController).name('auth.passkeys');
  factors.post('/settings/passkeys/options', PasskeyRegistrationOptionsController).name('auth.passkeys.options');
  factors.post('/settings/passkeys', RegisterPasskeyController).name('auth.passkeys.store').block();
  sudo.put('/settings/passkeys/:passkey', RenamePasskeyController).name('auth.passkeys.update');
  factors.post('/settings/passkeys/:passkey/release', ReleasePasskeyController).name('auth.passkeys.release').block();
  factors.post('/settings/passkeys/:passkey/remove', RemovePasskeyController).name('auth.passkeys.destroy').block();
  // Ending one sign-in: sudo mode (a stolen session must not sign its owner out elsewhere without the password). The id is looked up
  // within `ctx.user`'s own sign-ins; another account's is not found. Without a bound `SignInStore` (AuthServiceProvider) the page lists none.
  sudo.post('/settings/sign-ins/:signIn/end', EndSignInController).name('auth.sign-ins.destroy');
  sudo.get('/settings/tokens', ShowAccessTokensController).name('auth.tokens');
  // Creating one is a layer over the list; its answer — the plain text — replaces it, shown once.
  sudo.get('/settings/tokens/create', ShowCreateAccessTokenController).name('auth.tokens.create');
  // A new token and a new address are as good as a factor of one's own: a stolen session must not make either with the password alone.
  factors.post('/settings/tokens', CreateAccessTokenController).name('auth.tokens.store');
  sudo.delete('/settings/tokens/:token', RevokeAccessTokenController).name('auth.tokens.destroy');

  // E-mail verification: the link is signed (made by the app, expires) — and only for its own user. Internal: only
  // the server builds it (for the mail), so the browser never learns its name or pattern.
  account.get('/email/verify', ShowVerifyEmailNoticeController).name('auth.verification.notice');
  account.middleware(signed()).get('/email/verify/:id/:hash', VerifyEmailController).name('auth.verification.verify').internal();
  account.middleware(throttle('verification')).post('/email/verification-notification', ResendVerificationController).name('auth.verification.send');
  // The link to a new address (private registration): signed, expiring, for its own user and request only — internal too
  // (404 with AUTH_PRIVATE_REGISTRATION=false).
  account.middleware(signed()).get('/email/change/:id/:token', ConfirmEmailChangeController).name('auth.email.confirm').internal();
});
