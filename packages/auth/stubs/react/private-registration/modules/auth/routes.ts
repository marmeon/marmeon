import { authenticate, confirmedPassword, guest, verified } from '@bespokecore/auth';
import { throttle } from '@bespokecore/cache';
import { defineRoutes, signed } from '@bespokecore/http';
import { ConfirmPasswordController } from './controllers/ConfirmPasswordController.ts';
import { CreateAccessTokenController } from './controllers/CreateAccessTokenController.ts';
import { LoginController } from './controllers/LoginController.ts';
import { LogoutController } from './controllers/LogoutController.ts';
import { LogoutOtherDevicesController } from './controllers/LogoutOtherDevicesController.ts';
import { RegisterController } from './controllers/RegisterController.ts';
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
import { ShowRegisterController } from './controllers/ShowRegisterController.ts';
import { ShowRegistrationSentController } from './controllers/ShowRegistrationSentController.ts';
import { ShowSecurityController } from './controllers/ShowSecurityController.ts';
import { ShowVerifyEmailNoticeController } from './controllers/ShowVerifyEmailNoticeController.ts';
import { UpdateEmailController } from './controllers/UpdateEmailController.ts';
import { UpdatePasswordController } from './controllers/UpdatePasswordController.ts';
import { VerifyEmailController } from './controllers/VerifyEmailController.ts';

// Loaded into the `web` middleware group: encrypted cookies and the session come with it.
export default defineRoutes((Route) => {
  // Guests only: signed-in people go to the dashboard.
  const guests = Route.middleware(guest('/dashboard'));
  guests.get('/login', ShowLoginController).name('auth.login');
  guests.post('/login', LoginController).name('auth.login.store');
  guests.get('/register', ShowRegisterController).name('auth.register');
  // A few sign-ups per minute and address (E100) — live validation of the form does not count.
  guests.middleware(throttle('register')).post('/register', RegisterController).name('auth.register.store');
  // Private registration (E146): every sign-up ends here — a new address and a known one alike.
  guests.get('/register/sent', ShowRegistrationSentController).name('auth.register.sent');
  guests.get('/forgot-password', ShowForgotPasswordController).name('auth.password.request');
  guests.middleware(throttle('password-reset')).post('/forgot-password', SendPasswordResetLinkController).name('auth.password.email');
  guests.get('/reset-password', ShowResetPasswordController).name('auth.password.reset');
  guests.post('/reset-password', ResetPasswordController).name('auth.password.store');

  const signedIn = Route.middleware(authenticate());
  signedIn.post('/logout', LogoutController).name('auth.logout');
  // Private registration (E146): the app is for confirmed addresses only — whoever signed up with somebody else's address
  // (it was free then) signs in, but sees nothing but the notice until the link from that inbox is clicked while signed in.
  const confirmedAddress = signedIn.middleware(verified());
  confirmedAddress.get('/dashboard', ShowDashboardController).name('dashboard');
  confirmedAddress.get('/confirm-password', ShowConfirmPasswordController).name('auth.password.confirm');
  confirmedAddress.post('/confirm-password', ConfirmPasswordController).name('auth.password.confirm.store');
  // "Sudo mode": the security page asks for the password again unless it was typed within 15 minutes.
  confirmedAddress.middleware(confirmedPassword()).get('/settings/security', ShowSecurityController).name('auth.security');
  // A new hash in the database and its fingerprint in the session must stay a pair: one of these requests per session at a
  // time (block(), E145) — two at once could leave the session with the other's fingerprint, and sign it out.
  confirmedAddress.put('/settings/password', UpdatePasswordController).name('auth.password.update').block();
  confirmedAddress.post('/settings/devices/logout', LogoutOtherDevicesController).name('auth.devices.logout').block();
  confirmedAddress.middleware(confirmedPassword()).put('/settings/email', UpdateEmailController).name('auth.email.update');
  // API tokens: as good as a session — sudo mode for all of it.
  const sudo = confirmedAddress.middleware(confirmedPassword());
  sudo.get('/settings/tokens', ShowAccessTokensController).name('auth.tokens');
  sudo.post('/settings/tokens', CreateAccessTokenController).name('auth.tokens.store');
  sudo.delete('/settings/tokens/:token', RevokeAccessTokenController).name('auth.tokens.destroy');

  // E-mail verification: the link is signed (made by the app, expires) — and only for its own user. Internal: only
  // the server builds it (for the mail), so the browser never learns its name or pattern.
  signedIn.get('/email/verify', ShowVerifyEmailNoticeController).name('auth.verification.notice');
  signedIn.middleware(signed()).get('/email/verify/:id/:hash', VerifyEmailController).name('auth.verification.verify').internal();
  signedIn.middleware(throttle('verification')).post('/email/verification-notification', ResendVerificationController).name('auth.verification.send');
});
