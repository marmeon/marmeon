import { createTestApp } from '@marmeon/testing';
import { it, vi } from 'vitest';
import application from '../../bootstrap/app.ts';
import { UserFactory } from '../auth/index.ts';
import type { ShowNoteController } from './controllers/ShowNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

// Booting the app on a refreshed database takes seconds on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

it('shows a note to its author', async () => {
  const app = await createTestApp(application, { database: 'refresh' });
  const ada = await app.factory(UserFactory).create();
  const note = await app.make(NoteRepository).insert({ user_id: ada.id, title: 'Groceries', body: 'Milk' });
  await app
    .actingAs(ada)
    .navigating()
    .get(`/notes/${note.id}`)
    .assertOk()
    .assertPage<ShowNoteController>('notes/Show', { note: { title: 'Groceries' } });
});
