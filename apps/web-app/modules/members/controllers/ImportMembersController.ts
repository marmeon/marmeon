import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { Storage, upload } from '@marmeon/storage';
import { rules as r } from '@marmeon/validation';
import { MemberPolicy } from '../policies/MemberPolicy.ts';

/**
 * The member list as a file: a CSV (or any other text) uploaded ahead, at most 1 MB. `text: true` checks the file's first bytes:
 * no image, PDF, archive or program, no HTML or SVG at the start, no NUL (Windows-1252 and UTF-16 with a byte order mark are text).
 * The file stays data: it waits on the private `uploads` disk, which serves nothing.
 */
export const ImportMembersRequest = defineRequest({
  schema: r.object({ file: upload({ maxBytes: 1_000_000, text: true }) }),
  authorize: can(MemberPolicy, 'import'),
});

export class ImportMembersController extends Controller {
  static request = ImportMembersRequest;

  readonly #storage: Storage;
  readonly #translator: Translator;

  constructor(storage: Storage, translator: Translator) {
    super();
    this.#storage = storage;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ImportMembersRequest>) {
    const { size } = ctx.body.file;
    // Uses the upload up (once) and keeps it as imports/<random>.bin — reading the rows is the app's business from here.
    await ctx.body.file.store(this.#storage.disk('uploads'), 'imports');
    return this.redirect().route('members.index').flash('toast', { kind: 'success', message: this.#translator.get('members.imported', { size }) });
  }
}
