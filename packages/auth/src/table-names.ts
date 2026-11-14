const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * Checks a table name an auth store was given: lower case letters, digits and underscores, at most 63 of them (Postgres cuts a longer name, and two names would meet in one table). A name reaches the statements as an
 * identifier, never as text, but a name that is not plain fails here, where the store is built, not at the first query.
 */
export function assertTableName(owner: string, name: string): string {
  if (!TABLE_NAME.test(name)) throw new TypeError(`${owner}: "${name}" is not a plain table name (lower case letters, digits and underscores, at most 63).`);
  return name;
}
