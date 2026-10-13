import type { Container, ServiceProvider } from '@marmeon/core';
import { SecondFactorPasskeys } from '../two-factor/state.ts';
import { PasskeyConfig } from './config.ts';
import { Passkeys } from './passkeys.ts';
import { PasskeyStore } from './store.ts';

/**
 * Switches passkeys on: registers `PasskeyStore` and `Passkeys` and lets `TwoFactor.challenge({ passkey })` accept a passkey. Add it to
 * the providers of the app that offers passkeys — an app without it has no passkey configuration, no routes and never loads the WebAuthn
 * library. The relying party is checked on first use, not at boot.
 *
 * Passkeys count as a second factor once `TwoFactorState` knows them: `container.bind(TwoFactorState, (c) => combineFactors(c.make(TwoFactorStore), c.make(PasskeyStore)))`.
 */
export class PasskeyServiceProvider implements ServiceProvider {
  static config = [PasskeyConfig];

  register(container: Container): void {
    container.singleton(PasskeyStore);
    container.scoped(Passkeys);
    container.scoped(SecondFactorPasskeys, (scope) => scope.make(Passkeys));
  }
}
