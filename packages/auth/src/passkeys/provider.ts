import type { Application, Container, ServiceProvider } from '@marmeon/core';
import { Connections } from '@marmeon/database';
import { SecondFactorPasskeys } from '../two-factor/state.ts';
import { PasskeyConfig } from './config.ts';
import { Passkeys } from './passkeys.ts';
import { PASSKEY_COLUMNS, PASSKEYS_TABLE, PasskeyStore } from './store.ts';

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

  async boot(app: Application): Promise<void> {
    if (!app.container.has(Connections)) return;
    // /up/ready is red until the table has the new name and every column the store uses.
    const { SchemaRequirements } = await import('@marmeon/database');
    app.container.make(SchemaRequirements).require({ connection: 'default', table: PASSKEYS_TABLE, columns: PASSKEY_COLUMNS, secrets: [] });
  }
}
