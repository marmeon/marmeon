import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/index.ts';
import { BookmarkRepository } from './BookmarkRepository.ts';

let app: TestApp;
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

describe('sharing a bookmark', { timeout: 30_000 }, () => {
  it('answers the same for every address, and refuses a stranger', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const kj = await app.factory(UserFactory).state('unverified').create();
    const bookmark = await app.make(BookmarkRepository).insert({ user_id: ada.id, title: 'Shared' });
    const message = 'If that address has an account, the bookmark is shared.';
    const share = (email: string) =>
      app.actingAs(ada).post(`/bookmarks/${bookmark.id}/share`, { form: { email } }).assertRedirect('/bookmarks').assertFlashed('toast', { kind: 'success', message });

    await share(bob.email);
    await share(kj.email);
    await share('nobody@example.com');
    await share(ada.email);
    await share(bob.email);
    await app.actingAs(bob).post(`/bookmarks/${bookmark.id}/share`, { form: { email: ada.email } }).assertNotFound();
  });
});
