import { authenticate } from '@marmeon/auth';
import { defineRoutes } from '@marmeon/http';
import { ConfirmedAddress } from '#modules/auth';
import { CreateNoteController } from './controllers/CreateNoteController.ts';
import { DeleteNoteController } from './controllers/DeleteNoteController.ts';
import { EditNoteController } from './controllers/EditNoteController.ts';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { PinNoteController } from './controllers/PinNoteController.ts';
import { StoreNoteController } from './controllers/StoreNoteController.ts';
import { UnpinNoteController } from './controllers/UnpinNoteController.ts';
import { UpdateNoteController } from './controllers/UpdateNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

// Signed in, with a confirmed address like the dashboard. A note in the URL is looked up by its id and then checked
// against the signed-in user by NotePolicy: somebody else's note is a 404.
export default defineRoutes((Route) => {
  const notes = Route.prefix('/notes').middleware(authenticate()).middleware(ConfirmedAddress).name('notes.');

  notes.get('/', ListNotesController).name('index');
  notes.get('/create', CreateNoteController).name('create');
  notes.post('/', StoreNoteController).name('store');

  const note = notes.bind('note', NoteRepository);
  note.get('/:note/edit', EditNoteController).name('edit');
  note.put('/:note', UpdateNoteController).name('update');
  note.put('/:note/pin', PinNoteController).name('pin');
  note.delete('/:note/pin', UnpinNoteController).name('unpin');
  note.delete('/:note', DeleteNoteController).name('destroy');
});
