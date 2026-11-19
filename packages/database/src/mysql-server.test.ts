import { describe, expect, it } from 'vitest';
import { mysqlServerProblem } from './mysql-server.ts';

const MYSQL_URL = process.env.MARMEON_TEST_MYSQL_URL;
const COMMUNITY = 'MySQL Community Server - GPL';

describe('mysqlServerProblem', () => {
  it.each(['8.4.3', '8.4.0-commercial', '9.1.0', '8.4.2-2', '8.4.6-0ubuntu0.26.04.1+esm1', '8.4.3-1~bpo12+1', '8.4.3-1+deb13u1', '8.10.0', '8.5.0', '8.4.3+x', '8.4.3_x', '8.4.3-multidb'])('accepts MySQL %s', (version) => {
    expect(mysqlServerProblem(version, COMMUNITY)).toBeUndefined();
  });

  it.each(['10.11.6-MariaDB', '11.4.2-MariaDB-ubu2404', '5.5.5-10.11.6-MariaDB'])('refuses MariaDB %s by name', (version) => {
    expect(mysqlServerProblem(version, 'mariadb.org binary distribution')).toContain('the server is MariaDB');
  });

  it.each([
    ['8.4.3', 'mariadb.org binary distribution'],
    ['10.11.6-mariadb', 'x'],
    ['8.4.3', 'MariaDB Server'],
    ['10.11.6-MariaDB', COMMUNITY],
  ])('refuses MariaDB named in the version or the comment in any case (%s, %s)', (version, comment) => {
    expect(mysqlServerProblem(version, comment)).toContain('the server is MariaDB');
  });

  it.each([
    ['8.4.0-TiDB-v9.0.0', ''],
    ['8.0.11-TiDB-v7.5.1', 'TiDB Server'],
  ])('refuses TiDB (%s, %s)', (version, comment) => {
    expect(mysqlServerProblem(version, comment)).toContain('the server is TiDB');
  });

  it.each(['11.4.2-MariaDB1', '8.4.0-TiDB7', '8.4.3-1MariaDB'])('refuses %s: a digit next to the name still names the product', (version) => {
    expect(mysqlServerProblem(version, COMMUNITY)).toContain('the server is');
  });

  it.each([['8.4.3', 'Acme TiDBase'], ['8.4.3', 'vitessx']])('accepts a letter after or before the name (%s, %s)', (version, comment) => {
    expect(mysqlServerProblem(version, comment)).toBeUndefined();
  });

  it('does not mistake a word with a product name inside for the product', () => {
    expect(mysqlServerProblem('8.4.3', 'Acme MultiDB build')).toBeUndefined();
  });

  it.each([
    ['8.4.0', 'TiDB Server'],
    ['8.4.6', 'Vitess'],
    ['8.4.3-MariaDB-0+deb12u1', COMMUNITY],
  ])('refuses a product named only in the comment or after a separator (%s, %s)', (version, comment) => {
    expect(mysqlServerProblem(version, comment)).toContain('the server is');
  });

  it('refuses Vitess', () => {
    expect(mysqlServerProblem('8.4.6-Vitess', '')).toContain('the server is Vitess');
  });

  it.each(['8.0.40', '8.3.0', '8.0.40-0ubuntu0.22.04.1', '8.3.0-commercial', '7.9.9+x', '8.3.9-8.4'])('refuses %s as older than 8.4', (version) => {
    expect(mysqlServerProblem(version, COMMUNITY)).toContain('older than');
  });

  it.each(['8.0.mysql_aurora.3.05.2', '', '8.4', '8.4.3-a b', '8.4.3-a\nb', '8.4.3-a\u0000b', '8.4.3 ', '8.4.3-', '8.4.3+', '8.4.3_', '8.4.3-\u00e9'])('refuses the version form %j as unknown', (version) => {
    expect(mysqlServerProblem(version, COMMUNITY)).toContain('unknown version form');
  });
});

describe.runIf(MYSQL_URL)('the compose server', () => {
  it('is a MySQL the framework supports', async () => {
    const { createConnection } = await import('mysql2/promise');
    const connection = await createConnection(MYSQL_URL!);
    try {
      const [rows] = await connection.query('select @@version as version, @@version_comment as comment');
      const { version, comment } = (rows as { version: string; comment: string }[])[0]!;
      expect(mysqlServerProblem(version, comment)).toBeUndefined();
    } finally {
      await connection.end();
    }
  });
});
