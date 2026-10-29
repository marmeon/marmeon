import { can } from '@marmeon/auth';
import { abort, Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { StagedUploads, upload, type TemporaryUpload } from '@marmeon/storage';
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

/** What an import is kept under between its preview and its confirmation. */
export const IMPORT_SCOPE = 'members-import';

/** How long a previewed file waits for the confirmation. */
const CONFIRM_WITHIN_MINUTES = 30;

/** What one row of the file has to be — the same rules as a form's. */
const ROW = r.object({ name: r.string().trim().required().max(255), email: r.string().trim().lowercase().required().max(255).email() });

/** The file's rows checked like a form's: how many were read and how many need correcting, or the message for the file's field. */
async function checkRows(file: TemporaryUpload, translator: Translator): Promise<{ rows: number; invalid: number } | { message: string }> {
  // bytes() reads the file without using the upload up: nothing is stored, and a failed import can be sent again.
  const csv = readCsv(await file.bytes(), { unescape: true });
  if (!csv.ok) return { message: csv.error.message };
  const { headers, rows } = csv.value;
  const columns = ['name', 'email'].map((name) => headers.findIndex((header) => header.trim().toLowerCase() === name));
  if (columns.includes(-1)) return { message: translator.get('members.import_columns') };
  let invalid = 0;
  for (const row of rows) {
    const member = await validate(ROW, { name: row[columns[0]!], email: row[columns[1]!] }, { translator });
    if (!member.ok) invalid++;
  }
  return { rows: rows.length, invalid };
}

/**
 * The first step of the import: reads the file and shows what it holds. A file that passes is kept for 30 minutes — it stays bound to the
 * session — and its id goes to the next page in the toast's `confirm`, for {@link ConfirmMemberImportController}.
 */
export class ImportMembersController extends Controller {
  static request = ImportMembersRequest;

  readonly #translator: Translator;

  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof ImportMembersRequest>) {
    const checked = await checkRows(ctx.body.file, this.#translator);
    if ('message' in checked) return this.redirect().back().withErrors({ file: [checked.message] });
    const id = await ctx.body.file.keep({ scope: IMPORT_SCOPE, minutes: CONFIRM_WITHIN_MINUTES });
    return this.redirect()
      .route('members.index')
      .flash('toast', { kind: checked.invalid === 0 ? 'success' : 'info', message: this.#translator.get('members.imported', checked), confirm: id });
  }
}

/** Authorizes the confirmation the way the preview is: administrators only. */
export const ConfirmMemberImportRequest = defineRequest({ authorize: can(MemberPolicy, 'import') });

/**
 * The second step: finds the file the preview kept — only in the session that sent it, under this flow's scope and before it
 * expired; any other id is a 404 — checks it again and drops it.
 */
export class ConfirmMemberImportController extends Controller {
  static request = ConfirmMemberImportRequest;

  readonly #translator: Translator;
  readonly #uploads: StagedUploads;

  constructor(translator: Translator, uploads: StagedUploads) {
    super();
    this.#translator = translator;
    this.#uploads = uploads;
  }

  async handle(ctx: ContextOf<typeof ConfirmMemberImportRequest> & { params: { import: string } }) {
    const file = await this.#uploads.staged(ctx.params.import, IMPORT_SCOPE);
    if (!file) abort(404);
    const checked = await checkRows(file, this.#translator);
    // Dropping the file is the claim: of two confirmations at once only one gets it, and the other finds nothing.
    if (!(await file.discard())) abort(404);
    if ('message' in checked) return this.redirect().route('members.index').flash('toast', { kind: 'info', message: checked.message });
    return this.redirect()
      .route('members.index')
      .flash('toast', { kind: 'success', message: this.#translator.get('members.import_confirmed', { rows: checked.rows - checked.invalid }) });
  }
}
