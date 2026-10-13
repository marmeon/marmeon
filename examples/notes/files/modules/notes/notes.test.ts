import { createTestApp, type TestApp } from '@marmeon/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory, UserRepository } from '../auth/index.ts';
import type { ListNotesController } from './controllers/ListNotesController.ts';
import { NoteRepository } from './NoteRepository.ts';

// Who may see and change which note.

let app: TestApp;
// Every test boots the app on a refreshed database — seconds on a busy machine, so its hook and tests get 30 s.
beforeEach(async () => {
  app = await createTestApp(application, { database: 'refresh' });
}, 30_000);

const notes = () => app.make(NoteRepository);

describe('the notes', { timeout: 30_000 }, () => {
  it('sends a guest to the sign-in page', async () => {
    await app.get('/notes').assertRedirect('/login');
    await app.get('/notes/create').assertRedirect('/login');
    await app.post('/notes', { form: { title: 'Hello', body: '' } }).assertRedirect('/login');
  });

  it('lists only the notes of the signed-in user, the pinned ones first', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    await notes().insert({ user_id: ada.id, title: 'Groceries', body: 'Milk' });
    await notes().insert({ user_id: ada.id, title: 'Ideas', body: 'Many', pinned: true });
    await notes().insert({ user_id: bob.id, title: 'Secret', body: 'Not for Ada' });

    await app.actingAs(ada).navigating().get('/notes').assertPage<ListNotesController>('notes/ListNotes', (props) => {
      expect(props.notes.data.map((note) => note.title)).toEqual(['Ideas', 'Groceries']);
      expect(props.notes.meta.total).toBe(2);
    });
  });

  it('pages the list', async () => {
    const ada = await app.factory(UserFactory).create();
    for (let number = 1; number <= 12; number++) await notes().insert({ user_id: ada.id, title: `Note ${number}`, body: '' });
    await app.actingAs(ada).navigating().get('/notes?page=2').assertPage<ListNotesController>('notes/ListNotes', (props) => {
      expect(props.notes.data).toHaveLength(2);
      expect(props.notes.meta.lastPage).toBe(2);
    });
  });

  it('creates a note for the signed-in user', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).navigating().get('/notes/create').assertPage('notes/Form', { note: null });
    await app.actingAs(ada).post('/notes', { form: { title: '  Groceries  ', body: 'Milk' } }).assertRedirect('/notes');
    expect(await notes().firstWhere({ user_id: ada.id })).toMatchObject({ title: 'Groceries', body: 'Milk', pinned: false });
  });

  it('keeps a note for the signed-in user whatever the form says', async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/notes', { form: { title: 'Mine', body: '', user_id: String(bob.id) } }).assertRedirect('/notes');
    expect(await notes().findBy('title', 'Mine')).toMatchObject({ user_id: ada.id });
  });

  it('refuses a note without a title, with a title that is too long or with a body that is', async () => {
    const ada = await app.factory(UserFactory).create();
    await app.actingAs(ada).post('/notes', { form: { title: ' ', body: 'x' } }).assertRedirect().assertInvalid(['title']);
    await app.actingAs(ada).post('/notes', { form: { title: 'x'.repeat(121), body: '' } }).assertRedirect().assertInvalid(['title']);
    await app.actingAs(ada).post('/notes', { form: { title: 'Long', body: 'x'.repeat(10_001) } }).assertRedirect().assertInvalid(['body']);
    expect(await notes().count()).toBe(0);
  });

  it('changes a note', async () => {
    const ada = await app.factory(UserFactory).create();
    const note = await notes().insert({ user_id: ada.id, title: 'Draft', body: '' });
    await app.actingAs(ada).navigating().get(`/notes/${note.id}/edit`).assertPage('notes/Form', { note: { id: note.id, title: 'Draft', body: '' } });
    await app.actingAs(ada).put(`/notes/${note.id}`, { form: { title: 'Final', body: 'Done' } }).assertRedirect('/notes');
    expect(await notes().find(note.id)).toMatchObject({ title: 'Final', body: 'Done' });
    await app.actingAs(ada).put(`/notes/${note.id}`, { form: { title: '', body: '' } }).assertRedirect().assertInvalid(['title']);
  });

  it('pins a note and unpins it again', async () => {
    const ada = await app.factory(UserFactory).create();
    const note = await notes().insert({ user_id: ada.id, title: 'Important', body: '' });
    await app.actingAs(ada).put(`/notes/${note.id}/pin`).assertRedirect();
    await app.actingAs(ada).put(`/notes/${note.id}/pin`).assertRedirect();
    expect((await notes().find(note.id))!.pinned).toBe(true);
    await app.actingAs(ada).delete(`/notes/${note.id}/pin`).assertRedirect();
    expect((await notes().find(note.id))!.pinned).toBe(false);
  });

  it('deletes a note', async () => {
    const ada = await app.factory(UserFactory).create();
    const note = await notes().insert({ user_id: ada.id, title: 'Obsolete', body: '' });
    await app.actingAs(ada).delete(`/notes/${note.id}`).assertRedirect('/notes');
    expect(await notes().find(note.id)).toBeUndefined();
  });

  it("answers 404 for somebody else's note, however it is reached", async () => {
    const ada = await app.factory(UserFactory).create();
    const bob = await app.factory(UserFactory).create();
    const note = await notes().insert({ user_id: bob.id, title: 'Secret', body: 'Not for Ada' });
    const ada404 = app.actingAs(ada);
    await ada404.get(`/notes/${note.id}/edit`).assertNotFound();
    await ada404.put(`/notes/${note.id}`, { form: { title: 'Mine now', body: '' } }).assertNotFound();
    await ada404.put(`/notes/${note.id}/pin`).assertNotFound();
    await ada404.delete(`/notes/${note.id}/pin`).assertNotFound();
    await ada404.delete(`/notes/${note.id}`).assertNotFound();
    await ada404.get('/notes/999999/edit').assertNotFound();
    expect(await notes().find(note.id)).toMatchObject({ title: 'Secret', pinned: false });
  });

  it('deletes the notes with their user', async () => {
    const ada = await app.factory(UserFactory).create();
    await notes().insert({ user_id: ada.id, title: 'Gone with Ada', body: '' });
    await app.make(UserRepository).deleteAccounts([ada.id]);
    expect(await notes().count()).toBe(0);
  });
});
