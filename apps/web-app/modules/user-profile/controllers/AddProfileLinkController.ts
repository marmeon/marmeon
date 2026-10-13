import { can } from '@marmeon/auth';
import type { Row } from '@marmeon/database';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Broadcaster } from '@marmeon/live';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { profileChannel } from '../live.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const AddProfileLinkRequest = defineRequest({
  schema: r.object({
    label: r.string().trim().required().max(60),
    // http(s) only — url()'s default: a `javascript:` URL in an href would run in every visitor's browser.
    url: r.string().trim().required().url().max(2048),
  }),
  messages: { 'label.required': 'user-profile.validation.link_label', 'url.required': 'user-profile.validation.link_url', 'url.url': 'user-profile.validation.link_url' },
  authorize: can(ProfilePolicy, 'update', 'user'),
});

export class AddProfileLinkController extends Controller {
  static request = AddProfileLinkRequest;

  readonly #links: ProfileLinkRepository;
  readonly #translator: Translator;
  readonly #broadcast: Broadcaster;

  constructor(links: ProfileLinkRepository, translator: Translator, broadcast: Broadcaster) {
    super();
    this.#links = links;
    this.#translator = translator;
    this.#broadcast = broadcast;
  }

  async handle(ctx: ContextOf<typeof AddProfileLinkRequest> & { params: { user: Row<'users'> } }) {
    await this.#links.insert({ user_id: ctx.params.user.id, ...ctx.body });
    // Live: the profile's other tabs reload it — not this one (x-marmeon-connection), it shows its own answer.
    await this.#broadcast.refresh(profileChannel(ctx.params.user.public_id), { only: ['profile'] });
    return this.redirect().route('user-profile.show', { user: ctx.params.user.public_id }).flash('toast', { kind: 'success', message: this.#translator.get('user-profile.status.link_added') });
  }
}
