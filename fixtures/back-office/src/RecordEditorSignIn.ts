import { EditorSignInLog } from './EditorSignInLog.ts';
import { EditorSlot } from './guard.ts';
import { OfficeRoles } from './OfficeRoles.ts';

/**
 * Records the editor sign-ins: one entry of the mode and the id for each. The app lists it for `EditorSlot.events.SignedIn`
 * (`docs/package-users.md#what-the-app-does-for-the-back-office`). A slot bound to the app's users hears every sign-in of the app, customers
 * included, so it records only the ones the back office gives a role.
 */
export class RecordEditorSignIn {
  static readonly inject = [EditorSignInLog, OfficeRoles] as const;

  readonly #log: EditorSignInLog;
  readonly #roles: OfficeRoles;

  constructor(log: EditorSignInLog, roles: OfficeRoles) {
    this.#log = log;
    this.#roles = roles;
  }

  async handle(event: InstanceType<typeof EditorSlot.events.SignedIn>): Promise<void> {
    const role = await this.#roles.roleOf(event.user.id);
    if (role !== 'editor' && role !== 'viewer') return;
    this.#log.record({ guard: event.guard, userId: event.user.id, at: event.at });
  }
}
