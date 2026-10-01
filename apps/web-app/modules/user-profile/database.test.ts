import type { Database } from '@bespokecore/database';
import { expectTypeOf, it } from 'vitest';

// Checked by the compiler against the generated `bootstrap/database.d.ts` (the body only runs trivially).
// Module boundaries are opt-in: `Database<'user-profile'>` asks for them, plain `Database` has none.
it('user-profile owns login_activity and may read — never write — the users that auth exposes', () => {
  const lastLogins = (db: Database<'user-profile'>) =>
    db
      .selectFrom('login_activity')
      .innerJoin('users', 'users.id', 'login_activity.user_id')
      .select(['users.name', 'login_activity.last_login_at'])
      .execute();
  expectTypeOf(lastLogins).returns.resolves.toEqualTypeOf<{ name: string; last_login_at: string }[]>();

  // @ts-expect-error — users belong to auth: user-profile changes them through the UserRepository
  void ((db: Database<'user-profile'>) => db.updateTable('users').set({ name: 'Ada' }).execute());
  // @ts-expect-error — a typo in the module name
  void ((db: Database<'user-profil'>) => db);

  // Without a module name: every table, no boundary — the default for apps that do not want one.
  void ((db: Database) => db.updateTable('users').set({ name: 'Ada' }).execute());
});
