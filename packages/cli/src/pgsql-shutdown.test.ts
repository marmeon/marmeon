import { describe, expect, it } from 'vitest';
import { marmeon, webApp } from './__fixtures__/cli.js';

describe('marmeon (in the web app)', { timeout: 30_000 }, () => {
  it.runIf(process.env.MARMEON_TEST_PGSQL_URL)('shuts the app down after a command, so an open Postgres pool does not keep it running', () => {
    const { code, stdout } = marmeon(webApp, ['db:show'], { DB_DRIVER: 'pgsql', DB_URL: process.env.MARMEON_TEST_PGSQL_URL! });
    expect(code).toBe(0);
    expect(stdout).toMatch(/Target {6}pgsql postgres:\/\/marmeon:\*\*\*@localhost:55432\/marmeon\nServer {6}PostgreSQL \d+/);
  });
});
