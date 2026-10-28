import type { Row } from '@marmeon/database';
import { abort } from '@marmeon/http';
import { LabConfig } from '../config.ts';
import { OneTimeLinkRepository } from '../OneTimeLinkRepository.ts';
import { LabController } from './ShowLabPageController.ts';

/** The path is the credential: no shared cache keeps the page, and no `Referer` carries the path to another site. */
const CREDENTIAL_PAGE = { 'cache-control': 'no-store, private', 'referrer-policy': 'no-referrer' } as const;

type Bound = { params: { link: Row<'lab_one_time_links'> }; request: { url: string } };

/** Makes a link that opens once and answers with its path — the only time the token is in the clear. */
export class CreateOneTimeLinkLabController extends LabController {
  readonly #links: OneTimeLinkRepository;

  constructor(config: LabConfig, links: OneTimeLinkRepository) {
    super(config);
    this.#links = links;
  }

  async handle() {
    this.enabled();
    return this.json({ path: `/lab/one-time-links/${await this.#links.create()}` }, { status: 201, headers: CREDENTIAL_PAGE });
  }
}

/** Opens a link: a page with a button. It uses nothing up — mail scanners and link previews fetch every link they see. */
export class OpenOneTimeLinkLabController extends LabController {
  handle(ctx: Bound) {
    this.enabled();
    return this.view('lab/OneTimeLink', { opened: false, path: new URL(ctx.request.url, 'http://localhost').pathname }, { headers: CREDENTIAL_PAGE });
  }
}

/** The button: the first request uses the link up, every later one — and every unknown token — gets the binder's 404. */
export class UseOneTimeLinkLabController extends LabController {
  readonly #links: OneTimeLinkRepository;

  constructor(config: LabConfig, links: OneTimeLinkRepository) {
    super(config);
    this.#links = links;
  }

  async handle(ctx: Bound) {
    this.enabled();
    // The conditional update decides, so two requests at once cannot both use it.
    if (!(await this.#links.redeem(ctx.params.link.id))) abort(404);
    return this.view('lab/OneTimeLink', { opened: true, path: new URL(ctx.request.url, 'http://localhost').pathname }, { headers: CREDENTIAL_PAGE });
  }
}
