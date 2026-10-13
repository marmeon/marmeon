import { Controller } from '@marmeon/http';

/** The empty form of a new note. */
export class CreateNoteController extends Controller {
  handle() {
    return this.view('notes/Form', { note: null });
  }
}
