import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const UnpinNoteRequest = defineRequest({ authorize: can(NotePolicy, 'update', 'note') });

/** Unpins a note. */
export class UnpinNoteController extends Controller {
  static request = UnpinNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof UnpinNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, { pinned: false });
    return this.back('/notes');
  }
}
