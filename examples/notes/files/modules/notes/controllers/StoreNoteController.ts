import type { Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { NoteRepository } from '../NoteRepository.ts';
import { noteFields } from '../noteFields.ts';

export const StoreNoteRequest = defineRequest({ schema: noteFields });

/** Saves a new note for the signed-in user. */
export class StoreNoteController extends Controller {
  static request = StoreNoteRequest;

  readonly #notes: NoteRepository;
  readonly #translator: Translator;

  constructor(notes: NoteRepository, translator: Translator) {
    super();
    this.#notes = notes;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof StoreNoteRequest> & Authenticated) {
    await this.#notes.insert({ user_id: ctx.user.id, title: ctx.body.title, body: ctx.body.body });
    return this.redirect().route('notes.index').flash('toast', { kind: 'success', message: this.#translator.get('notes.flash.created') });
  }
}
