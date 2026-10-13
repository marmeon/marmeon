import type { Authenticated } from '@marmeon/auth';
import { Passkeys } from '@marmeon/auth/passkeys';
import { TwoFactor } from '@marmeon/auth/two-factor';
import { Controller, type HttpContext } from '@marmeon/http';

/** The passkeys of the account — behind confirmedPassword() ("sudo mode"). */
export class ShowPasskeysController extends Controller {
  readonly #passkeys: Passkeys;
  readonly #twoFactor: TwoFactor;

  constructor(passkeys: Passkeys, twoFactor: TwoFactor) {
    super();
    this.#passkeys = passkeys;
    this.#twoFactor = twoFactor;
  }

  async handle(_ctx: HttpContext<Authenticated>) {
    const passkeys = await this.#passkeys.list();
    const status = await this.#twoFactor.status();
    return this.view('auth/Passkeys', {
      passkeys: passkeys.map((passkey) => ({ id: passkey.id, name: passkey.name, createdAt: passkey.createdAt, lastUsedAt: passkey.lastUsedAt, suspended: passkey.suspended, synced: passkey.synced })),
      // Removing the account's last factor asks for the password (and takes the recovery codes along).
      lastFactor: passkeys.length === 1 && status.factors.every((factor) => factor === 'passkey'),
      firstFactor: status.factors.length === 0,
    });
  }
}
