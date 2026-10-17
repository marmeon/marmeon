import { ErrorSolutions } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { DatabaseConnectionError } from './driver.ts';
import { databaseSolutions } from './solutions.ts';

describe('the database solutions tied to an error code', () => {
  const registry = new ErrorSolutions(databaseSolutions);

  it('answer a secret column that would leave the database', async () => {
    const found = await registry.find(new Error('[marmeon:D9] This query selects password, a secret column, without secret()'));
    expect(found.map((solution) => solution.code)).toEqual(['D9']);
    expect(await registry.find(new Error('[marmeon:D10] cannot check'))).toEqual([]);
  });

  it('answer a connection that cannot be made', async () => {
    const found = await registry.find(new DatabaseConnectionError('[marmeon:D11] Could not connect to the database connection "default"'));
    expect(found.map((solution) => solution.code)).toEqual(['D11']);
  });
});
