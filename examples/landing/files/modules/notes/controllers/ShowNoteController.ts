import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const ShowNoteRequest = defineRequest({ authorize: can(NotePolicy, 'view', 'note') });

export class ShowNoteController extends Controller {
  static request = ShowNoteRequest;

  // `note` is bound by the route: a missing one is a 404.
  handle(ctx: ContextOf<typeof ShowNoteRequest>) {
    return this.view('notes/Show', { note: ctx.params.note });
  }
}
