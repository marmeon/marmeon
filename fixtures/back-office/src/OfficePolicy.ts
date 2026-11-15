import { EditorSlot } from './guard.ts';
import { OfficeRoles } from './OfficeRoles.ts';
import type { EditorUser } from './OfficeUser.ts';

/** What an editor may do. It names the slot, so it judges the editors of the mode the back office runs in, never the other mode's accounts. */
export class OfficePolicy {
  static readonly guard = EditorSlot;
  static readonly inject = [OfficeRoles] as const;

  readonly #roles: OfficeRoles;

  constructor(roles: OfficeRoles) {
    this.#roles = roles;
  }

  /** Enter the back office: a role of the two the package knows, and nothing else. */
  async open(user: EditorUser): Promise<boolean> {
    const role = await this.#roles.roleOf(user.id);
    return role === 'editor' || role === 'viewer';
  }

  /** Publish: editors, not viewers. */
  async publish(user: EditorUser): Promise<boolean> {
    return (await this.#roles.roleOf(user.id)) === 'editor';
  }
}
