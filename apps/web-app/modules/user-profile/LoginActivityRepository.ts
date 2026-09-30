import { Repository } from '@bespokecore/database';

/** When each user last signed in — this module's own table. */
export class LoginActivityRepository extends Repository<'login_activity'> {
  static table = 'login_activity' as const;

  async record(userId: number, at: Date): Promise<void> {
    await this.db
      .insertInto('login_activity')
      .values({ user_id: userId, last_login_at: at })
      .onConflict((conflict) => conflict.column('user_id').doUpdateSet({ last_login_at: at }))
      .execute();
  }
}
