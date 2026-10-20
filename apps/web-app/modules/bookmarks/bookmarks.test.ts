import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory, UserRepository } from '../auth/index.ts';
import type { ListBookmarksController } from './controllers/ListBookmarksController.ts';
import { BookmarkRepository } from './BookmarkRepository.ts';

// Who may see and change which bookmark.

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

const bookmarks = () => app.make(BookmarkRepository);

describe('the bookmarks', { timeout: 30_000 }, () => {
  it('sends a guest to the sign-in page', async () => {
    await app.get('/bookmarks').assertRedirect('/login');
    await app.get('/bookmarks/create').assertRedirect('/login');
    await app.post('/bookmarks', { form: { title: 'Hello' } }).assertRedirect('/login');
  });

  it('lists only the bookmarks of the signed-in user', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    await bookmarks().insert({ user_id: ada.id, title: 'First' });
    await bookmarks().insert({ user_id: ada.id, title: 'Second' });
    await bookmarks().insert({ user_id: bob.id, title: 'Secret' });

    await app.actingAs(ada).navigating().get('/bookmarks').assertPage<ListBookmarksController>('bookmarks/ListBookmarks', (props) => {
      expect(props.bookmarks.data.map((bookmark) => bookmark.title).sort()).toEqual(['First', 'Second']);
      expect(props.bookmarks.meta.total).toBe(2);
    });
  });

  it('creates a bookmark for the signed-in user', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).navigating().get('/bookmarks/create').assertPage('bookmarks/Form', { bookmark: null });
    await app.actingAs(ada).post('/bookmarks', { form: { title: '  First  ' } }).assertRedirect('/bookmarks');
    expect(await bookmarks().firstWhere({ user_id: ada.id })).toMatchObject({ title: 'First' });
  });

  it('keeps a bookmark for the signed-in user whatever the form says', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/bookmarks', { form: { title: 'Mine', user_id: String(bob.id) } }).assertRedirect('/bookmarks');
    expect(await bookmarks().findBy('title', 'Mine')).toMatchObject({ user_id: ada.id });
  });

  it('refuses a bookmark without a title or with a title that is too long', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/bookmarks', { form: { title: ' ' } }).assertRedirect().assertInvalid(['title']);
    await app.actingAs(ada).post('/bookmarks', { form: { title: 'x'.repeat(121) } }).assertRedirect().assertInvalid(['title']);
    expect(await bookmarks().count()).toBe(0);
  });

  it('changes a bookmark', async () => {
    const ada = await app.factory(UserFactory).create();
    const bookmark = await bookmarks().insert({ user_id: ada.id, title: 'Draft' });
    await app.actingAs(ada).navigating().get(`/bookmarks/${bookmark.id}/edit`).assertPage('bookmarks/Form', { bookmark: { id: bookmark.id, title: 'Draft' } });
    await app.actingAs(ada).put(`/bookmarks/${bookmark.id}`, { form: { title: 'Final' } }).assertRedirect('/bookmarks');
    expect(await bookmarks().find(bookmark.id)).toMatchObject({ title: 'Final' });
    await app.actingAs(ada).put(`/bookmarks/${bookmark.id}`, { form: { title: '' } }).assertRedirect().assertInvalid(['title']);
  });

  it('deletes a bookmark', async () => {
    const ada = await app.factory(UserFactory).create();
    const bookmark = await bookmarks().insert({ user_id: ada.id, title: 'Obsolete' });
    await app.actingAs(ada).delete(`/bookmarks/${bookmark.id}`).assertRedirect('/bookmarks');
    expect(await bookmarks().find(bookmark.id)).toBeUndefined();
  });

  it("answers 404 for somebody else's bookmark, however it is reached", async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const bookmark = await bookmarks().insert({ user_id: bob.id, title: 'Secret' });
    const asAda = app.actingAs(ada);
    await asAda.get(`/bookmarks/${bookmark.id}/edit`).assertNotFound();
    await asAda.put(`/bookmarks/${bookmark.id}`, { form: { title: 'Mine now' } }).assertNotFound();
    await asAda.delete(`/bookmarks/${bookmark.id}`).assertNotFound();
    await asAda.get('/bookmarks/no-such-id/edit').assertNotFound();
    expect(await bookmarks().find(bookmark.id)).toMatchObject({ title: 'Secret' });
  });

  it('deletes the bookmarks with their user', async () => {
    const ada = await app.factory(UserFactory).create();
    await bookmarks().insert({ user_id: ada.id, title: 'Gone with Ada' });
    await app.make(UserRepository).deleteAccounts([ada.id]);
    expect(await bookmarks().count()).toBe(0);
  });
});
