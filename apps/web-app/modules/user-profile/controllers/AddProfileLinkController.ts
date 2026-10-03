import { can } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf } from '@bespokecore/http';
import { Broadcaster } from '@bespokecore/live';
import { trans, Translator } from '@bespokecore/i18n';
import * as v from 'valibot';
import { ProfilePolicy } from '../policies/ProfilePolicy.ts';
import { profileChannel } from '../live.ts';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const AddProfileLinkRequest = defineRequest({
  schema: v.object({
    label: v.pipe(v.string(), v.trim(), v.minLength(1, trans('user-profile.validation.link_label')), v.maxLength(60)),
    // http(s) only: a `javascript:` URL in an href would run in every visitor's browser.
    url: v.pipe(v.string(), v.trim(), v.url(trans('user-profile.validation.link_url')), v.regex(/^https?:\/\//i, trans('user-profile.validation.link_scheme')), v.maxLength(2048)),
  }),
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

  async handle(ctx: ContextOf<typeof AddProfileLinkRequest>) {
    await this.#links.insert({ user_id: ctx.params.user.id, ...ctx.body });
    // Live (W6.10): the profile's other tabs reload it — not this one (x-bespoke-connection), it shows its own answer.
    await this.#broadcast.refresh(profileChannel(ctx.params.user.id), { only: ['profile'] });
    return this.redirect().route('user-profile.show', { user: ctx.params.user.id }).flash('toast', { kind: 'success', message: this.#translator.get('user-profile.status.link_added') });
  }
}
