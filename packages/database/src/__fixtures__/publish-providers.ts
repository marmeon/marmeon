import type { MigrationUpgrade } from '../upgrades.ts';

const upgrade = (set: string, name: string, createdBy: string): MigrationUpgrade => ({
  set,
  revision: 2,
  name,
  createdBy: [createdBy],
  contents: `// @marmeon-stub ${set} 2\nexport default {};\n`,
});

/** Provider classes with upgrades, for packages that export them under their names (the identity of the class is what counts). */
export class PermissionsProvider {
  static migrationUpgrades = [upgrade('permissions', 'add_roles_label', 'create_permissions_table')];
}

export class QueueServiceProvider {
  static migrationUpgrades = [upgrade('queue', 'rename_queue_tables', 'create_queue_tables')];
}

export class AuthServiceProvider {
  static migrationUpgrades = [upgrade('auth', 'reissue_tokens', 'create_sign_ins_table')];
}

/** A provider that claims the set of another package through an upgrade of its own. */
export class SetGrabbingProvider {
  static migrationUpgrades = [{ ...upgrade('auth', 'move_email_changes_to_their_own_table', 'create_email_changes_table'), revision: 99 }];
}

/** A provider that claims the creating file of another package's tables as the one it upgrades from. */
export class NameGrabbingProvider {
  static migrationUpgrades = [upgrade('permissions', 'grab_jobs', 'create_jobs_table')];
}
