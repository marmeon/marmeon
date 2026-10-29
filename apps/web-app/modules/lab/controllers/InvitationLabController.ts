import type { Row } from '@marmeon/database';
import { abort, defineRequest, type ContextOf } from '@marmeon/http';
import { Session } from '@marmeon/session';
import { rules as r } from '@marmeon/validation';
import { LabConfig } from '../config.ts';
import { OneTimeLinkRepository } from '../OneTimeLinkRepository.ts';
import { LabController } from './ShowLabPageController.ts';

const INVITATION = 'lab.invitation';

/**
 * Who may see the form and send it: a session that holds an invitation whose link is still unused. The row is looked up on every
 * request, so a link used up in another session ends this one's right too.
 */
export class InvitationGate {
  readonly #config: LabConfig;
  readonly #session: Session;
  readonly #links: OneTimeLinkRepository;

  constructor(config: LabConfig, session: Session, links: OneTimeLinkRepository) {
    this.#config = config;
    this.#session = session;
    this.#links = links;
  }

  /** The open invitation of this session; a 404 otherwise, whatever the reason. */
  async open(): Promise<Row<'lab_one_time_links'>> {
    if (!this.#config.enabled) abort(404);
    const id = this.#session.get(INVITATION as never) as Row<'lab_one_time_links'>['id'] | undefined;
    const link = id === undefined ? undefined : await this.#links.findOpen(id);
    if (!link) abort(404);
    return link;
  }

  /** Ends the right of this session once the invitation is used. */
  end(): void {
    this.#session.forget(INVITATION);
  }
}

/**
 * A form behind a token, the recommended way: the token's route trades the token for the link's id in a new session id and
 * redirects to a page without the token. The form lives there, and `back()` finds it after a failed validation.
 */
export class ClaimInvitationLabController extends LabController {
  readonly #session: Session;

  constructor(config: LabConfig, session: Session) {
    super(config);
    this.#session = session;
  }

  handle(ctx: { params: { link: Row<'lab_one_time_links'> } }) {
    this.enabled();
    // A session id planted before (by whoever sent this link) must not carry the invitation.
    this.#session.regenerate();
    this.#session.put(INVITATION as never, ctx.params.link.id as never);
    return this.redirect('/lab/invitation');
  }
}

/** The page without the token: it says what the invitation is for, so a visitor sent here by someone else sees it. */
export class ShowInvitationLabController extends LabController {
  readonly #gate: InvitationGate;

  constructor(config: LabConfig, gate: InvitationGate) {
    super(config);
    this.#gate = gate;
  }

  async handle() {
    const link = await this.#gate.open();
    return this.view('lab/Invitation', { invitation: `Lab invitation ${String(link.id)}` });
  }
}

export const InvitationLabRequest = defineRequest({
  schema: r.object({ name: r.string().trim().required().max(40) }),
  // Before the schema runs: a visitor without an invitation learns nothing about the form.
  authorize: async (_ctx, resolve) => {
    await resolve(InvitationGate).open();
    return true;
  },
});

export class StoreInvitationLabController extends LabController {
  static request = InvitationLabRequest;
  readonly #gate: InvitationGate;
  readonly #links: OneTimeLinkRepository;

  constructor(config: LabConfig, gate: InvitationGate, links: OneTimeLinkRepository) {
    super(config);
    this.#gate = gate;
    this.#links = links;
  }

  async handle(ctx: ContextOf<typeof InvitationLabRequest>) {
    const link = await this.#gate.open();
    // The update decides, so two requests at once cannot both use it.
    if (!(await this.#links.redeem(link.id))) abort(404);
    this.#gate.end();
    return this.json({ name: ctx.body.name });
  }
}
