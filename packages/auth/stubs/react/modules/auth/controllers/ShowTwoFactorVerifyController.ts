import { Controller } from '@marmeon/http';

/** Asks a signed-in session for its second factor again — where `twoFactor()` sends a session that has not proven it (or not recently enough). */
export class ShowTwoFactorVerifyController extends Controller {
  handle() {
    return this.view('auth/TwoFactorVerify', {});
  }
}
