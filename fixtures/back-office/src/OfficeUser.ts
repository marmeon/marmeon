/** What the back office needs of an editor, whichever users it runs on: an id and a name to greet them with. */
export interface EditorUser {
  readonly id: number;
  readonly name: string;
}

/** What an editor may do: `editor` publishes, `viewer` only looks. */
export type OfficeRole = 'editor' | 'viewer';

/** `value` as a role, or `undefined` for anything else: a role nobody knows (`suspended`, an empty text, `null`) is no role, so it opens nothing. */
export function officeRole(value: unknown): OfficeRole | undefined {
  return value === 'editor' || value === 'viewer' ? value : undefined;
}

/** An editor of the back office's own table, `office_users`, without the password hash and the session key (secret columns). */
export interface OfficeUser extends EditorUser {
  readonly email: string;
  /** The stored text, which may be anything: `officeRole()` says whether it is a role, and only then does it open something. */
  readonly role: string;
}
