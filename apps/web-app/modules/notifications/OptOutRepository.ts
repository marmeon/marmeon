import { Repository } from '@marmeon/database';

/** The accounts that left the digest mails — this module's own table. */
export class OptOutRepository extends Repository<'notification_opt_outs'> {
  static table = 'notification_opt_outs' as const;

  /** Records the opt-out; leaving twice changes nothing. */
  async add(userId: number, at: Date): Promise<void> {
    await this.db
      .insertInto('notification_opt_outs')
      .values({ user_id: userId, created_at: at })
      .onConflict((conflict) => conflict.column('user_id').doNothing())
      .execute();
  }

  has(userId: number): Promise<boolean> {
    return this.exists(userId);
  }
}
