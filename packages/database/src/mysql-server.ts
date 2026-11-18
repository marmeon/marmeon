/** The oldest MySQL the framework supports: 8.4, the oldest long-term-support line still in support. */
const MINIMUM = [8, 4] as const;

/** `major.minor.patch`, then optionally a suffix of printable ASCII characters without spaces after `-`, `_` or `+` (distribution builds: `-0ubuntu0.26.04.1+esm1`, `-1~bpo12+1`). */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-_+][\x21-\x7e]+)?$/;

/** Servers that speak the MySQL protocol and name themselves in `@@version` or `@@version_comment`. */
const PRODUCTS = ['MariaDB', 'TiDB', 'Vitess'] as const;

/** The product's name as a word: `-TiDB-v7`, `TiDB Server`, `mariadb.org`, `MariaDB1` match, `multidb`, `TiDBase` do not. */
const named = (text: string, product: string): boolean => new RegExp(`(?<![a-z])${product}(?![a-z])`, 'i').test(text);

/**
 * Why the server behind a MySQL connection is not supported, or `undefined` when it is. `version` and `comment` are the server's
 * `@@version` and `@@version_comment`. MariaDB, TiDB and Vitess are refused by the name as a word in either, in any case; a version of
 * another form is refused instead of guessed at; the rest is decided by `major.minor.patch` against 8.4. A product that reports
 * a MySQL 8.4 version without naming itself is not recognised.
 */
export function mysqlServerProblem(version: string, comment: string): string | undefined {
  for (const product of PRODUCTS) {
    if (named(version, product) || named(comment, product)) {
      return `the server is ${product}; Marmeon supports MySQL ${MINIMUM.join('.')} or newer, not ${product}`;
    }
  }
  const match = VERSION.exec(version);
  if (!match) return `unknown version form "${version}"; Marmeon supports MySQL ${MINIMUM.join('.')} or newer`;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major < MINIMUM[0] || (major === MINIMUM[0] && minor < MINIMUM[1])) return `MySQL ${version} is older than ${MINIMUM.join('.')}; Marmeon supports MySQL ${MINIMUM.join('.')} or newer`;
  return undefined;
}
