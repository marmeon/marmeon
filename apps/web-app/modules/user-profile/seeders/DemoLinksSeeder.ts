import type { SeedContext } from '@marmeon/database';
import { ProfileLinkFactory } from '../factories/ProfileLinkFactory.ts';

/** Links on the demo profiles — after auth's DemoUsersSeeder (module order). */
export class DemoLinksSeeder {
  async handle({ db, factory }: SeedContext) {
    const ada = await db.selectFrom('users').select('id').where('email', '=', 'ada@example.com').executeTakeFirst();
    if (!ada) return;
    const links = factory(ProfileLinkFactory);
    await links.create({ user_id: ada.id, label: 'Notes on the Analytical Engine', url: 'https://en.wikipedia.org/wiki/Note_G' });
    await links.create({ user_id: ada.id, label: 'Ada (language)', url: 'https://ada-lang.io' });
  }
}
