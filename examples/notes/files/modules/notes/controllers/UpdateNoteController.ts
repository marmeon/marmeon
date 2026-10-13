import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { NoteRepository } from '../NoteRepository.ts';
import { noteFields } from '../noteFields.ts';
import { NotePolicy } from '../policies/NotePolicy.ts';

export const UpdateNoteRequest = defineRequest({ schema: noteFields, authorize: can(NotePolicy, 'update', 'note') });

/** Saves the changes to one of the user's notes. */
export class UpdateNoteController extends Controller {
  static request = UpdateNoteRequest;

  readonly #notes: NoteRepository;
  readonly #translator: Translator;

  constructor(notes: NoteRepository, translator: Translator) {
    super();
    this.#notes = notes;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof UpdateNoteRequest>) {
    await this.#notes.update(ctx.params.note.id, { title: ctx.body.title, body: ctx.body.body });
    return this.redirect().route('notes.index').flash('toast', { kind: 'success', message: this.#translator.get('notes.flash.updated') });
  }
}
