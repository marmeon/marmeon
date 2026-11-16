import { OFFICE_USERS_COLUMNS } from '@fixtures/back-office';
import { Connections, SchemaRequirements } from '@marmeon/database';
import { createTestApp, type TestApp } from '@marmeon/testing';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { WARM_UP_TIMEOUT, warmUpDatabase } from '../auth/warm-up.ts';

beforeAll(warmUpDatabase, WARM_UP_TIMEOUT);

// The stubs the app published, against what the package's code reads: the requirement the guard registers for its two tables (the stores' own lists
// of columns and secrets), and the one the package registers for `office_users`. A stub that drifts from them makes `/up/ready` red in an app that
// published it.
const NOW = new Date('2030-01-02T03:04:05.000Z');

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh', seed: true });
});
afterEach(() => app.close());

/** What a select-all of a row shows: every column but the secrets, which a read has to ask for. */
async function shown(table: string, values: Record<string, unknown>): Promise<string[]> {
  const db = app.make(Connections).get<any>();
  await db.insertInto(table).values(values).execute();
  return Object.keys(await db.selectFrom(table).selectAll().orderBy('created_at', 'desc').executeTakeFirstOrThrow()).sort();
}

describe('the tables of the back office, as the app migrated them', () => {
  const requirement = (table: string) => app.make(SchemaRequirements).all().find((entry) => entry.table === table)!;

  it.each([
    ['office_users', { name: 'Zed', email: 'zed@office.example.com', role: 'viewer', password: 'hash', session_key: 'k'.repeat(32), created_at: NOW, updated_at: NOW }, ['password', 'session_key']],
    [
      'office_sign_ins',
      {
        id: 'a'.repeat(22),
        user_id: 0,
        user_agent: 'Test',
        remember_selector: 's'.repeat(32),
        remember_until: NOW,
        signed_in_at: NOW,
        last_seen_at: NOW,
        created_at: NOW,
        updated_at: NOW,
        remember_validator_hash: 'v'.repeat(64),
        remember_previous_validator_hash: 'p'.repeat(64),
        remember_rotated_at: NOW,
        remember_created_at: NOW,
        remember_fingerprint: 'f'.repeat(64),
      },
      ['remember_selector', 'remember_validator_hash', 'remember_previous_validator_hash'],
    ],
    ['office_password_reset_tokens', { email: 'zed@office.example.com', token_hash: 't'.repeat(64), created_at: NOW }, ['token_hash']],
    ['office_two_factor_authentications', { user_id: 0, secret: 'encrypted', confirmed_at: NOW, last_used_step: 7, created_at: NOW, updated_at: NOW }, ['secret']],
    ['office_two_factor_recovery_codes', { user_id: 0, code_hash: 'h'.repeat(64), used_at: NOW, created_at: NOW, updated_at: NOW }, ['code_hash']],
    [
      'office_passkeys',
      {
        user_id: 0,
        user_handle: 'handle',
        credential_id: 'credential',
        public_key: 'key',
        algorithm: -7,
        sign_count: 0,
        transports: '[]',
        aaguid: 'a'.repeat(36),
        backup_eligible: false,
        backed_up: false,
        name: 'Laptop',
        last_used_at: NOW,
        suspended_at: NOW,
        created_at: NOW,
        updated_at: NOW,
      },
      [],
    ],
  ])('%s has exactly the columns the code requires, and a select-all shows none of the secrets', async (table, row, expectedSecrets) => {
    const { columns, secrets = [] } = requirement(table);
    const introspected = (await app.make(Connections).get<any>().introspection.getTables()).find((entry: { name: string }) => entry.name === table);
    expect(introspected!.columns.map((column: { name: string }) => column.name).sort()).toEqual([...columns].sort());
    // The secrets the code marks are the ones the stub marks: a column the code reads as a secret is never in a select-all.
    expect([...secrets].sort()).toEqual([...expectedSecrets].sort());
    const [{ id: editor }] = (await app.make(Connections).get().selectFrom('office_users').select('id').orderBy('id').execute()) as [{ id: number }];
    expect(await shown(table, 'user_id' in row ? { ...row, user_id: editor } : row)).toEqual(columns.filter((column) => !secrets.includes(column)).sort());
  });

  it('asks readiness for exactly the columns of `OFFICE_USERS_COLUMNS` on the editors’ table', () => {
    expect(requirement('office_users').columns).toEqual(OFFICE_USERS_COLUMNS);
  });
});
