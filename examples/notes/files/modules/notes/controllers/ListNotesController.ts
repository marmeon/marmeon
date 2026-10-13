import type { Authenticated } from '@marmeon/auth';
import { pageQuery } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { rules as r } from '@marmeon/validation';
import { NoteRepository } from '../NoteRepository.ts';

export const ListNotesRequest = defineRequest({
  query: r.query({ ...pageQuery({ perPage: 10 }) }),
});

/** The signed-in user's notes, ten to a page, the pinned ones first. */
export class ListNotesController extends Controller {
  static request = ListNotesRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof ListNotesRequest> & Authenticated) {
    return this.view('notes/ListNotes', { notes: await this.#notes.pageOf(ctx.user.id, ctx.query) });
  }
}
