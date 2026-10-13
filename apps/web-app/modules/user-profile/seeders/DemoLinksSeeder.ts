import type { SeedContext } from '@marmeon/database';
import { ProfileLinkFactory } from '../factories/ProfileLinkFactory.ts';

/** Links on the demo profiles — after auth's DemoUsersSeeder (module order). */
export class DemoLinksSeeder {
  async handle({ db, factory }: SeedContext) {
    const ada = await db.selectFrom('users').select('id').where('email', '=', 'ada@example.com').executeTakeFirst();
    if (!ada) return;
    const links = factory(ProfileLinkFactory);
    // Listed by `created_at`: a UUIDv7 id orders by the millisecond only, so rows made together get their own times.
    const earlier = new Date(Date.now() - 1000).toISOString();
    await links.create({ user_id: ada.id, label: 'Notes on the Analytical Engine', url: 'https://en.wikipedia.org/wiki/Note_G', created_at: earlier });
    await links.create({ user_id: ada.id, label: 'Ada (language)', url: 'https://ada-lang.io' });
  }
}
