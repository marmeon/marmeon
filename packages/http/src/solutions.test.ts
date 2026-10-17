import { ErrorSolutions } from '@marmeon/core';
import { RouteAccessError } from '@marmeon/router';
import { describe, expect, it } from 'vitest';
import { httpSolutions } from './solutions.ts';

const solutions = new ErrorSolutions(httpSolutions);

describe('httpSolutions', () => {
  it('finds an undefined route name by its code H4', async () => {
    const [solution] = await solutions.find(new Error('[marmeon:H4] Route [users.shwo] is not defined.'));
    expect(solution?.code).toBe('H4');
    expect(solution?.title).toBe('Name a route "users.shwo"');
  });

  it('finds a missing page by its code R2', async () => {
    const [solution] = await solutions.find(new Error('[marmeon:R2] Page [users/Show] not found.'));
    expect(solution?.code).toBe('R2');
    expect(solution?.title).toBe('Create modules/users/views/Show.tsx');
  });

  it('finds routes without a decision by their code H3', async () => {
    const [solution] = await solutions.find(new RouteAccessError('[marmeon:H3] 1 route does not say who may call it:'));
    expect(solution?.code).toBe('H3');
    expect(solution?.docs).toBe('docs/authorization.md#every-route-decides');
  });

  it('does not find a solution for the same text without the code', async () => {
    expect(await solutions.find(new RouteAccessError('1 route does not say who may call it:'))).toEqual([]);
    expect(await solutions.find(new Error('Route [users.show] is not defined.'))).toEqual([]);
    expect(await solutions.find(new Error('Page [users/Show] not found.'))).toEqual([]);
  });
});
