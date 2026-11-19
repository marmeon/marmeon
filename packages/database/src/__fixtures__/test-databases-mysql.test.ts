import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { dropOwnMysqlDatabases } from './test-databases.ts';

const MYSQL_URL = process.env.MARMEON_TEST_MYSQL_URL;

describe.runIf(MYSQL_URL)('dropping the test databases of a checkout on MySQL', () => {
  // Random tags, never this checkout's own: a neighbouring test's databases cannot fall. The names therefore carry no tag the real
  // teardown knows, so a run aborted between creating and dropping them leaves them on the server.
  const tag = randomBytes(4).toString('hex');
  const other = randomBytes(4).toString('hex');
  const own = `marmeon_test_${tag}_a`;
  const lookalike = `marmeon_test_${tag}x_a`;
  const foreign = `marmeon_test_${other}_a`;

  async function connect() {
    const { createConnection } = await import('mysql2/promise');
    return createConnection(MYSQL_URL!);
  }

  afterAll(async () => {
    const connection = await connect();
    try {
      for (const name of [own, lookalike, foreign]) await connection.query(`drop database if exists \`${name}\``);
    } finally {
      await connection.end();
    }
  });

  it('drops the databases of the given tag and leaves a tag that starts alike, another tag, marmeon and the system databases', async () => {
    const connection = await connect();
    try {
      for (const name of [own, lookalike, foreign]) await connection.query(`create database \`${name}\``);
      await dropOwnMysqlDatabases(MYSQL_URL!, tag);
      const [rows] = await connection.query('show databases');
      const left = (rows as { Database: string }[]).map((row) => row.Database);
      expect(left).not.toContain(own);
      expect(left).toEqual(expect.arrayContaining([lookalike, foreign, 'marmeon', 'mysql', 'information_schema', 'performance_schema', 'sys']));
    } finally {
      await connection.end();
    }
  });
});
