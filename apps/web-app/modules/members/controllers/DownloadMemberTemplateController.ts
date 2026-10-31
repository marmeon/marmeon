import { can } from '@marmeon/auth';
import { Controller, defineRequest } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { contentDisposition } from '@marmeon/storage';
import { MemberPolicy } from '../policies/MemberPolicy.ts';

export const DownloadMemberTemplateRequest = defineRequest({ authorize: can(MemberPolicy, 'import') });

/**
 * The file the import expects, made in memory: the two columns and one example row. Its name comes from the translated messages
 * (German has umlauts), so it goes through `contentDisposition()` instead of into the header as it is.
 */
export class DownloadMemberTemplateController extends Controller {
  static request = DownloadMemberTemplateRequest;

  readonly #translator: Translator;

  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }

  handle() {
    return new Response('name,email\r\nAda Lovelace,ada@example.com\r\n', {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': contentDisposition('attachment', this.#translator.get('members.template_file')),
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
      },
    });
  }
}
