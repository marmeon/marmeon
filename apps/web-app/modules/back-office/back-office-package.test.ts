import { OFFICE_USERS_COLUMNS } from '@fixtures/back-office';
import { SchemaRequirements } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterAll, beforeAll, expect, it } from 'vitest';
import definition from '../../bootstrap/app.ts';

let app: TestApp;
beforeAll(async () => {
  app = await createTestApp(definition);
});
afterAll(() => app.close());

// The app has taken over what the package ships: five migrations, the tables of the guard `office` (sign-ins, reset tokens, second factors, passkeys) and its editors, in the module `back-office`.
it('has every migration of @fixtures/back-office', async () => {
  const run = await app.command('publish', { args: ['@fixtures/back-office'], options: { check: true } });
  expect(run.lines).toEqual(['✓ Every migration of @fixtures/back-office is in your app']);
  expect(run.code).toBe(0);
});

it('proposes the module `back-office` and declares its stubs on the package’s provider', () => {
  const declared = app.application.providers.flatMap((Provider) => (Provider.name === 'BackOfficeServiceProvider' && Provider.migrations !== undefined ? [Provider.migrations] : []));
  expect(declared).toHaveLength(1);
  expect(declared[0]!.module).toBe('back-office');
  expect(declared[0]!.from.pathname).toMatch(/\/fixtures\/back-office\/stubs\/migrations$/);
});

it('makes readiness wait for the editors’ table and the guard’s tables, with the secrets marked', () => {
  const required = app.make(SchemaRequirements).all();
  expect(required.find((requirement) => requirement.table === 'office_users')).toEqual({ connection: 'default', table: 'office_users', columns: OFFICE_USERS_COLUMNS, secrets: ['password', 'session_key'] });
  expect(required.map((requirement) => requirement.table).filter((table) => table.startsWith('office_')).sort()).toEqual(['office_passkeys', 'office_password_reset_tokens', 'office_sign_ins', 'office_two_factor_authentications', 'office_two_factor_recovery_codes', 'office_users']);
});
