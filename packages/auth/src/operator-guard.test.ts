import type { Resolver } from '@marmeon/core';
import { describe, expect, it } from 'vitest';
import { GuardContext } from './guard-context.ts';
import { OperatorGuards } from './operator-guard.ts';
import { guardContext } from './test-helpers/guard-context.ts';

const context = guardContext();
const resolver: Resolver = { make: ((key: unknown) => (key === GuardContext ? context : undefined)) as Resolver['make'] };

describe('OperatorGuards', () => {
  it('lists only the app when no package guard is registered', () => {
    const guards = new OperatorGuards(resolver, { has: () => false });
    expect(guards.names()).toEqual([]);
    const refused = guards.resolve('office');
    expect(refused).toEqual({ ok: false, error: { kind: 'refused', message: 'No guard is named "office". The guards are: web.' } });
  });

  it('answers no option and web with the app, and builds its context from the resolver it was given', () => {
    const guards = new OperatorGuards(resolver, { has: () => false });
    for (const option of [undefined, 'web', ['web']]) {
      const found = guards.resolve(option);
      expect(found.ok && found.value.name).toBeUndefined();
      expect(found.ok && found.value.context()).toBe(context);
    }
  });

  it.each([[true, '--guard names a guard, it is not a flag. The guards are: web.'], [['web', 'web'], '--guard is given once, not 2 times. The guards are: web.']])('refuses %j', (option, message) => {
    expect(new OperatorGuards(resolver, { has: () => false }).resolve(option)).toEqual({ ok: false, error: { kind: 'refused', message } });
  });
});
