import { authenticate, verified } from '@marmeon/auth';
import { defineRoutes, everyone } from '@marmeon/http';
import { CreateNoteController } from './controllers/CreateNoteController.ts';
import { DeleteNoteController } from './controllers/DeleteNoteController.ts';
import { EditNoteController } from './controllers/EditNoteController.ts';
import { ListNotesController } from './controllers/ListNotesController.ts';
import { PinNoteController } from './controllers/PinNoteController.ts';
import { StoreNoteController } from './controllers/StoreNoteController.ts';
import { UnpinNoteController } from './controllers/UnpinNoteController.ts';
import { UpdateNoteController } from './controllers/UpdateNoteController.ts';
import { NoteRepository } from './NoteRepository.ts';

// Signed in, with a confirmed address. A note in the URL is looked up by its id and then checked
// against the signed-in user by NotePolicy: somebody else's note is a 404.
export default defineRoutes((Route) => {
  const notes = Route.prefix('/notes').middleware(authenticate()).middleware(verified()).name('notes.');

  // These three never take a note from the path: the list asks for `ctx.user.id`, and a new note is created for the signed-in user.
  const mine = notes.authorize(everyone);
  mine.get('/', ListNotesController).name('index');
  mine.get('/create', CreateNoteController).name('create');
  mine.post('/', StoreNoteController).name('store');

  const note = notes.bind('note', NoteRepository);
  note.get('/:note/edit', EditNoteController).name('edit');
  note.put('/:note', UpdateNoteController).name('update');
  note.put('/:note/pin', PinNoteController).name('pin');
  note.delete('/:note/pin', UnpinNoteController).name('unpin');
  note.delete('/:note', DeleteNoteController).name('destroy');
});
