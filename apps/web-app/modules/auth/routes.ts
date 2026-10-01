import { authenticate, confirmedPassword, guest } from '@bespokecore/auth';
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
import { ShowAccessTokensController } from './controllers/ShowAccessTokensController.ts';
import { SendPasswordResetLinkController } from './controllers/SendPasswordResetLinkController.ts';
import { ShowForgotPasswordController } from './controllers/ShowForgotPasswordController.ts';
import { ShowResetPasswordController } from './controllers/ShowResetPasswordController.ts';
import { ShowConfirmPasswordController } from './controllers/ShowConfirmPasswordController.ts';
import { ShowLoginController } from './controllers/ShowLoginController.ts';
import { ShowRegisterController } from './controllers/ShowRegisterController.ts';
import { ShowSecurityController } from './controllers/ShowSecurityController.ts';
import { ShowVerifyEmailNoticeController } from './controllers/ShowVerifyEmailNoticeController.ts';
import { UpdateEmailController } from './controllers/UpdateEmailController.ts';
import { UpdatePasswordController } from './controllers/UpdatePasswordController.ts';
import { VerifyEmailController } from './controllers/VerifyEmailController.ts';

// Loaded into the `web` middleware group: encrypted cookies and the session come with it.
export default defineRoutes((Route) => {
  // Guests only: signed-in people go to their profile.
  const guests = Route.middleware(guest('/users/me'));
  guests.get('/', ShowLoginController);
  guests.get('/login', ShowLoginController).name('auth.login');
  guests.post('/login', LoginController).name('auth.login.store');
  guests.get('/register', ShowRegisterController).name('auth.register');
  guests.post('/register', RegisterController).name('auth.register.store');
  guests.get('/forgot-password', ShowForgotPasswordController).name('auth.password.request');
  guests.middleware(throttle('password-reset')).post('/forgot-password', SendPasswordResetLinkController).name('auth.password.email');
  guests.get('/reset-password', ShowResetPasswordController).name('auth.password.reset');
  guests.post('/reset-password', ResetPasswordController).name('auth.password.store');

  const signedIn = Route.middleware(authenticate());
  signedIn.post('/logout', LogoutController).name('auth.logout');
  signedIn.get('/confirm-password', ShowConfirmPasswordController).name('auth.password.confirm');
  signedIn.post('/confirm-password', ConfirmPasswordController).name('auth.password.confirm.store');
  // "Sudo mode": the security page asks for the password again unless it was typed within 15 minutes.
  signedIn.middleware(confirmedPassword()).get('/settings/security', ShowSecurityController).name('auth.security');
  signedIn.put('/settings/password', UpdatePasswordController).name('auth.password.update');
  signedIn.post('/settings/devices/logout', LogoutOtherDevicesController).name('auth.devices.logout');
  signedIn.middleware(confirmedPassword()).put('/settings/email', UpdateEmailController).name('auth.email.update');
  // API tokens: as good as a session — sudo mode for all of it.
  const sudo = signedIn.middleware(confirmedPassword());
  sudo.get('/settings/tokens', ShowAccessTokensController).name('auth.tokens');
  sudo.post('/settings/tokens', CreateAccessTokenController).name('auth.tokens.store');
  sudo.delete('/settings/tokens/:token', RevokeAccessTokenController).name('auth.tokens.destroy');

  // E-mail verification: the link is signed (made by the app, expires) — and only for its own user. Internal: only
  // the server builds it (for the mail), so the browser never learns its name or pattern.
  signedIn.get('/email/verify', ShowVerifyEmailNoticeController).name('auth.verification.notice');
  signedIn.middleware(signed()).get('/email/verify/:id/:hash', VerifyEmailController).name('auth.verification.verify').internal();
  signedIn.middleware(throttle('verification')).post('/email/verification-notification', ResendVerificationController).name('auth.verification.send');
});
