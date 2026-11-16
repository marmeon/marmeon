import { Controller } from '@marmeon/http';
import { OfficePasskeys, OfficeTwoFactor } from './guard.ts';

/** The editor's second factors: the authenticator app, the recovery codes and the passkeys. Behind the sudo mode and a recently proven factor. */
export class ShowOfficeSecurityController extends Controller {
  static readonly inject = [OfficeTwoFactor, OfficePasskeys] as const;

  readonly #twoFactor: OfficeTwoFactor;
  readonly #passkeys: OfficePasskeys;

  constructor(twoFactor: OfficeTwoFactor, passkeys: OfficePasskeys) {
    super();
    this.#twoFactor = twoFactor;
    this.#passkeys = passkeys;
  }

  async handle() {
    const status = await this.#twoFactor.status();
    const passkeys = await this.#passkeys.list();
    return this.view('office::Security', {
      enabled: status.factors.includes('totp'),
      // Any factor, a passkey alone included: the recovery codes belong to the editor, so they are listed and renewable.
      secured: status.factors.length > 0,
      // The key and the QR code are sent while the setup is unconfirmed only; once the factor is on they are not sent again.
      setup: status.settingUpTotp ? ((await this.#twoFactor.setup()) ?? null) : null,
      recoveryCodesLeft: status.recoveryCodesLeft,
      passkeys: passkeys.map((passkey) => ({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt, suspended: passkey.suspended })),
      // The password is asked for every passkey. Removing the last factor takes the recovery codes along, and the page says so before the password is typed.
      lastFactor: passkeys.length === 1 && status.factors.every((factor) => factor === 'passkey'),
    });
  }
}
