import { can } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { upload } from '@marmeon/storage';
import { readCsv } from '@marmeon/table';
import { rules as r, validate } from '@marmeon/validation';
import { MemberPolicy } from '../policies/MemberPolicy.ts';

/**
 * The member list as a file: a CSV (or any other text) uploaded ahead, at most 1 MB. `text: true` checks the file's first bytes:
 * no image, PDF, archive or program, no HTML or SVG at the start, no NUL (Windows-1252 and UTF-16 with a byte order mark are text).
 * The file stays data: it is read, never stored.
 */
export const ImportMembersRequest = defineRequest({
  schema: r.object({ file: upload({ maxBytes: 1_000_000, text: true }) }),
  authorize: can(MemberPolicy, 'import'),
});

export class ImportMembersController extends Controller {
  static request = ImportMembersRequest;

  /** What one row of the file has to be — the same rules as a form's. */
  static readonly row = r.object({ name: r.string().trim().required().max(255), email: r.string().trim().lowercase().required().max(255).email() });

  readonly #translator: Translator;

  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ImportMembersRequest>) {
    // bytes() reads the file without using the upload up: nothing is stored, and a failed import can be sent again.
    const csv = readCsv(await ctx.body.file.bytes(), { unescape: true });
    if (!csv.ok) return this.redirect().back().withErrors({ file: [csv.error.message] });
    const { headers, rows } = csv.value;
    const columns = ['name', 'email'].map((name) => headers.findIndex((header) => header.trim().toLowerCase() === name));
    if (columns.includes(-1)) return this.redirect().back().withErrors({ file: [this.#translator.get('members.import_columns')] });
    let invalid = 0;
    for (const row of rows) {
      const member = await validate(ImportMembersController.row, { name: row[columns[0]!], email: row[columns[1]!] }, { translator: this.#translator });
      if (!member.ok) invalid++;
    }
    return this.redirect()
      .route('members.index')
      .flash('toast', { kind: invalid === 0 ? 'success' : 'info', message: this.#translator.get('members.imported', { rows: rows.length, invalid }) });
  }
}
