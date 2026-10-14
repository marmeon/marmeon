import { authenticate, confirmedPassword, guest } from '@marmeon/auth';
import { confirmedSecondFactor } from '@marmeon/auth/two-factor';
import { throttle } from '@marmeon/cache';
import { defineRoutes, everyone, signed } from '@marmeon/http';
import { BeginTwoFactorController } from './controllers/BeginTwoFactorController.ts';
import { ConfirmEmailChangeController } from './controllers/ConfirmEmailChangeController.ts';
import { ConfirmPasswordController } from './controllers/ConfirmPasswordController.ts';
import { ConfirmTwoFactorController } from './controllers/ConfirmTwoFactorController.ts';
import { CreateAccessTokenController } from './controllers/CreateAccessTokenController.ts';
import { DisableTwoFactorController } from './controllers/DisableTwoFactorController.ts';
import { EndSignInController } from './controllers/EndSignInController.ts';
import { LoginController } from './controllers/LoginController.ts';
import { LogoutController } from './controllers/LogoutController.ts';
import { LogoutOtherDevicesController } from './controllers/LogoutOtherDevicesController.ts';
import { PasskeyChallengeController } from './controllers/PasskeyChallengeController.ts';
import { PasskeyChallengeOptionsController } from './controllers/PasskeyChallengeOptionsController.ts';
import { PasskeyRegistrationOptionsController } from './controllers/PasskeyRegistrationOptionsController.ts';
import { PasskeyStepUpController } from './controllers/PasskeyStepUpController.ts';
import { PasskeyStepUpOptionsController } from './controllers/PasskeyStepUpOptionsController.ts';
import { PasskeySignInController } from './controllers/PasskeySignInController.ts';
import { PasskeySignInOptionsController } from './controllers/PasskeySignInOptionsController.ts';
import { RedirectToTwoFactorController } from './controllers/RedirectToTwoFactorController.ts';
import { RegenerateRecoveryCodesController } from './controllers/RegenerateRecoveryCodesController.ts';
import { RegisterController } from './controllers/RegisterController.ts';
import { RegisterPasskeyController } from './controllers/RegisterPasskeyController.ts';
import { ReleasePasskeyController } from './controllers/ReleasePasskeyController.ts';
import { RemovePasskeyController } from './controllers/RemovePasskeyController.ts';
import { RenamePasskeyController } from './controllers/RenamePasskeyController.ts';
import { ResendVerificationController } from './controllers/ResendVerificationController.ts';
import { ResetPasswordController } from './controllers/ResetPasswordController.ts';
import { RevokeAccessTokenController } from './controllers/RevokeAccessTokenController.ts';
import { ShowDashboardController } from './controllers/ShowDashboardController.ts';
import { ShowAccessTokensController } from './controllers/ShowAccessTokensController.ts';
import { SendPasswordResetLinkController } from './controllers/SendPasswordResetLinkController.ts';
import { ShowForgotPasswordController } from './controllers/ShowForgotPasswordController.ts';
import { ShowResetPasswordController } from './controllers/ShowResetPasswordController.ts';
import { ShowConfirmPasswordController } from './controllers/ShowConfirmPasswordController.ts';
import { ShowLoginController } from './controllers/ShowLoginController.ts';
import { ShowPasskeysController } from './controllers/ShowPasskeysController.ts';
import { ShowRegisterController } from './controllers/ShowRegisterController.ts';
import { ShowRegistrationSentController } from './controllers/ShowRegistrationSentController.ts';
import { ShowSecurityController } from './controllers/ShowSecurityController.ts';
import { ShowTwoFactorChallengeController } from './controllers/ShowTwoFactorChallengeController.ts';
import { ShowTwoFactorController } from './controllers/ShowTwoFactorController.ts';
import { ShowVerifyEmailNoticeController } from './controllers/ShowVerifyEmailNoticeController.ts';
import { TwoFactorChallengeController } from './controllers/TwoFactorChallengeController.ts';
import { ShowTwoFactorVerifyController } from './controllers/ShowTwoFactorVerifyController.ts';
import { TwoFactorVerifyController } from './controllers/TwoFactorVerifyController.ts';
import { UpdateEmailController } from './controllers/UpdateEmailController.ts';
import { UpdatePasswordController } from './controllers/UpdatePasswordController.ts';
import { VerifyEmailController } from './controllers/VerifyEmailController.ts';
import { ConfirmedAddress } from './middleware/ConfirmedAddress.ts';

// Loaded into the `web` middleware group: encrypted cookies and the session come with it.
export default defineRoutes((Route) => {
  // Guests only: signed-in people go to the dashboard.
  // Decided for this module's own routes only: signing in and signing up are for people who are not signed in yet, and `guest()` turns
  // signed-in people away. A route you add needs its own decision.
  const guests = Route.middleware(guest('/dashboard')).authorize(everyone);
  guests.get('/login', ShowLoginController).name('auth.login');
  guests.post('/login', LoginController).name('auth.login.store');
  // The second step of signing in: a correct password waits here for the code (a guest still — nobody is signed in yet). One
  // request per session at a time (block()): two codes at once could not both be counted.
  guests.get('/two-factor-challenge', ShowTwoFactorChallengeController).name('auth.two-factor.challenge');
  guests.post('/two-factor-challenge', TwoFactorChallengeController).name('auth.two-factor.challenge.store').block();
  // Passkeys, the browser's way in: sign in with one alone, or prove one after the password. JSON in and out; the session's one challenge
  // is opened by the options request and spent by the answer (one per session at a time: block()). The throttle per address and the check of
  // the account live inside `Passkeys`; the options only get a loose limit against load.
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
  // in. `verified()` then; with AUTH_PRIVATE_REGISTRATION=false everyone signed in passes (middleware/ConfirmedAddress.ts).
  const confirmedAddress = account.middleware(ConfirmedAddress);
  confirmedAddress.get('/dashboard', ShowDashboardController).name('dashboard');
  confirmedAddress.get('/confirm-password', ShowConfirmPasswordController).name('auth.password.confirm');
  confirmedAddress.post('/confirm-password', ConfirmPasswordController).name('auth.password.confirm.store');
  // "Sudo mode": the security page asks for the password again unless it was typed within 15 minutes.
  confirmedAddress.middleware(confirmedPassword()).get('/settings/security', ShowSecurityController).name('auth.security');
  // A new hash in the database and its fingerprint in the session must stay a pair: one of these requests per session at a
  // time (block()) — two at once could leave the session with the other's fingerprint, and sign it out.
  confirmedAddress.put('/settings/password', UpdatePasswordController).name('auth.password.update').block();
  confirmedAddress.post('/settings/devices/logout', LogoutOtherDevicesController).name('auth.devices.logout').block();
  // A new address is pending until the link sent to it is clicked — the same answer for every address; a few requests a minute
  // per user (each one sends a mail somewhere). With AUTH_PRIVATE_REGISTRATION=false it changes at once, unverified.
  confirmedAddress.middleware(confirmedPassword()).middleware(confirmedSecondFactor({ verify: 'auth.two-factor.verify' })).middleware(throttle('email-change')).put('/settings/email', UpdateEmailController).name('auth.email.update');
  // API tokens and the second factor: as good as a session — sudo mode for all of it.
  const sudo = confirmedAddress.middleware(confirmedPassword());
  // Changing the factors takes a factor proven within 15 minutes as well, where the account has one: the password alone, with a session
  // that is older than that, must not add a factor of its own or take one away. An account without a factor passes — its first one needs
  // only the password — which keeps the setup page reachable. Confirming a setup is left out, like the sudo mode.
  const factors = sudo.middleware(confirmedSecondFactor({ verify: 'auth.two-factor.verify' }));
  // The second factor: sudo mode for all of it; turning it off asks for the password again.
  factors.get('/settings/two-factor', ShowTwoFactorController).name('auth.two-factor');
  factors.post('/settings/two-factor/setup', BeginTwoFactorController).name('auth.two-factor.begin');
  // Confirming needs a signed-in user and the password in the form, not sudo mode: the code of a setup that took a while to scan must not be lost.
  confirmedAddress.post('/settings/two-factor/confirm', ConfirmTwoFactorController).name('auth.two-factor.confirm');
  factors.post('/settings/two-factor/recovery-codes', RegenerateRecoveryCodesController).name('auth.two-factor.codes');
  // The recovery codes are layers that answer these POSTs, shown once; Forward asks their URLs with a GET (the settings page).
  confirmedAddress.get('/settings/two-factor/confirm', RedirectToTwoFactorController);
  confirmedAddress.get('/settings/two-factor/recovery-codes', RedirectToTwoFactorController);
  factors.post('/settings/two-factor/disable', DisableTwoFactorController).name('auth.two-factor.disable');
  // Proving the factor again in this session — where the `twoFactor()` middleware (docs/two-factor-authentication.md#in-the-starter-kit) sends
  // a session that has not. A wrong code ends nothing; one request per session at a time (block()), as at the sign-in.
  confirmedAddress.get('/settings/two-factor/verify', ShowTwoFactorVerifyController).name('auth.two-factor.verify');
  confirmedAddress.post('/settings/two-factor/verify', TwoFactorVerifyController).name('auth.two-factor.verify.store').block();
  // The same with a passkey: the options open a challenge, so they have a limit of their own (per user); the check is throttled per account inside `TwoFactor`.
  confirmedAddress.middleware(throttle('passkey-step-up-options')).post('/settings/two-factor/verify/passkey/options', PasskeyStepUpOptionsController).name('auth.passkeys.step-up.options');
  confirmedAddress.post('/settings/two-factor/verify/passkey', PasskeyStepUpController).name('auth.passkeys.step-up').block();
  // Passkeys: sudo mode and a recently proven factor for all of it but renaming; adding one asks for the password again, removing the last factor too.
  factors.get('/settings/passkeys', ShowPasskeysController).name('auth.passkeys');
  factors.post('/settings/passkeys/options', PasskeyRegistrationOptionsController).name('auth.passkeys.options');
  factors.post('/settings/passkeys', RegisterPasskeyController).name('auth.passkeys.store').block();
  sudo.put('/settings/passkeys/:passkey', RenamePasskeyController).name('auth.passkeys.update');
  factors.post('/settings/passkeys/:passkey/release', ReleasePasskeyController).name('auth.passkeys.release').block();
  factors.post('/settings/passkeys/:passkey/remove', RemovePasskeyController).name('auth.passkeys.destroy').block();
  // Ending one of the account's other sign-ins (the list on the security page): sudo mode, because a stolen session must not sign its owner out
  // elsewhere. The id is looked up within `ctx.user`'s own sign-ins — another account's is answered like an unknown one.
  sudo.post('/settings/sign-ins/:signIn/end', EndSignInController).name('auth.sign-ins.destroy');
  sudo.get('/settings/tokens', ShowAccessTokensController).name('auth.tokens');
  // A new token and a new address are as good as a factor of one's own: a stolen session must not make either with the password alone.
  factors.post('/settings/tokens', CreateAccessTokenController).name('auth.tokens.store');
  sudo.delete('/settings/tokens/:token', RevokeAccessTokenController).name('auth.tokens.destroy');

  // E-mail verification: the link is signed (made by the app, expires) — and only for its own user. Internal: only
  // the server builds it (for the mail), so the browser never learns its name or pattern.
  account.get('/email/verify', ShowVerifyEmailNoticeController).name('auth.verification.notice');
  account.middleware(signed()).get('/email/verify/:id/:hash', VerifyEmailController).name('auth.verification.verify').internal();
  account.middleware(throttle('verification')).post('/email/verification-notification', ResendVerificationController).name('auth.verification.send');
  // The link to a new address: signed, expiring, for its own user and request only — internal too (404 with
  // AUTH_PRIVATE_REGISTRATION=false: no change waits for a link then).
  account.middleware(signed()).get('/email/change/:id/:token', ConfirmEmailChangeController).name('auth.email.confirm').internal();
});
