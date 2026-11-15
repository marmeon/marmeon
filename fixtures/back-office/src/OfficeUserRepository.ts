import { credentialWriter, type Credentials, type PasswordHash, type UserProvider } from '@marmeon/auth';
import { Connections, secret, type Generated, type Secret } from '@marmeon/database';
import { officeRole, type OfficeRole, type OfficeUser } from './OfficeUser.ts';

/** The columns of `office_users` (the first stub of the package). */
interface OfficeUsersTable {
  id: Generated<number>;
  name: string;
  email: string;
  role: Generated<string>;
  password: Secret<string>;
  session_key: Secret<string | null>;
  created_at: Generated<string | Date>;
  updated_at: Generated<string | Date>;
}

/** The columns readiness waits for on `office_users`. */
export const OFFICE_USERS_COLUMNS = ['id', 'name', 'email', 'role', 'password', 'session_key', 'created_at', 'updated_at'] as const satisfies readonly (keyof OfficeUsersTable)[];

/**
 * Where the back office's guard finds its editors: the table `office_users`, never the app's `users`. It is the only place that reads the
 * password hash, which travels next to the user and never inside it.
 */
export class OfficeUserRepository implements UserProvider<OfficeUser> {
  static readonly inject = [Connections] as const;

  readonly #connections: Connections;

  constructor(connections: Connections) {
    this.#connections = connections;
  }

  async findById(id: number): Promise<Credentials<OfficeUser> | undefined> {
    return credentialsOf(await this.#select().where('id', '=', id).executeTakeFirst());
  }

  /** By e-mail, as the login request normalized it (trimmed, lower case). */
  async findForSignIn(email: string): Promise<Credentials<OfficeUser> | undefined> {
    return credentialsOf(await this.#select().where('email', '=', email).executeTakeFirst());
  }

  /** The role of the editor with this id: `undefined` for nobody and for a role the package does not know. */
  async roleOf(id: number): Promise<OfficeRole | undefined> {
    return officeRole((await this.#db().selectFrom('office_users').select('role').where('id', '=', id).executeTakeFirst())?.role);
  }

  updatePasswordHash(id: number, hash: PasswordHash, options?: { expected?: PasswordHash; sessionKey?: string; expectedSessionKey?: string | null }): Promise<boolean> {
    return this.#writer().updatePasswordHash(id, hash, options);
  }

  updateSessionKey(id: number, key: string, expected: string | null | undefined): Promise<boolean> {
    return this.#writer().updateSessionKey(id, key, expected);
  }

  updateEverySessionKey(key: string): Promise<{ accounts: number; sampleId: number | undefined }> {
    return this.#writer().updateEverySessionKey(key);
  }

  /** The package's statements for the hash and the session key, on this table. */
  #writer() {
    return credentialWriter<OfficeUser>(this.#db(), { table: 'office_users' });
  }

  #db() {
    return this.#connections.get<{ office_users: OfficeUsersTable }>();
  }

  /** The editor's columns, and the two secrets only because the guard asks for them here. */
  #select() {
    return this.#db()
      .selectFrom('office_users')
      .select(['id', 'name', 'email', 'role'])
      .select((eb) => [secret(eb, 'password'), secret(eb, 'session_key')]);
  }
}

function credentialsOf(row: (OfficeUser & { password: string; session_key: string | null }) | undefined): Credentials<OfficeUser> | undefined {
  if (row === undefined) return undefined;
  const { password, session_key: sessionKey, ...user } = row;
  return { user, passwordHash: password as PasswordHash, sessionKey };
}
