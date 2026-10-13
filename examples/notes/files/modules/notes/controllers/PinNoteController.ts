import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const PinNoteRequest = defineRequest({ authorize: can(NotePolicy, 'update', 'note') });

/** Pins a note — `PUT`, so pinning it twice is the same as once. */
export class PinNoteController extends Controller {
  static request = PinNoteRequest;

  readonly #notes: NoteRepository;

  constructor(notes: NoteRepository) {
    super();
    this.#notes = notes;
  }

  async handle(ctx: ContextOf<typeof PinNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, { pinned: true });
    return this.back('/notes');
  }
}
