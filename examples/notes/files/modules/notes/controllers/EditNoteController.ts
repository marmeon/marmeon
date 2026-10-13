import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const EditNoteRequest = defineRequest({ authorize: can(NotePolicy, 'update', 'note') });

/** The form of one of the user's notes — somebody else's note answers 404 before this runs. */
export class EditNoteController extends Controller {
  static request = EditNoteRequest;

  handle(ctx: ContextOf<typeof EditNoteRequest>) {
    const { id, title, body } = ctx.params.note;
    return this.view('notes/Form', { note: { id, title, body } });
  }
}
