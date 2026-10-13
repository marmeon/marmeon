import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { NoteRepository } from '../NoteRepository.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const DeleteNoteRequest = defineRequest({ authorize: can(NotePolicy, 'delete', 'note') });

/** Deletes one of the user's notes. */
export class DeleteNoteController extends Controller {
  static request = DeleteNoteRequest;

  readonly #notes: NoteRepository;
  readonly #translator: Translator;

  constructor(notes: NoteRepository, translator: Translator) {
    super();
    this.#notes = notes;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof DeleteNoteRequest>) {
    await this.#notes.delete(ctx.params.note.id);
    return this.redirect().route('notes.index').flash('toast', { kind: 'success', message: this.#translator.get('notes.flash.deleted') });
  }
}
