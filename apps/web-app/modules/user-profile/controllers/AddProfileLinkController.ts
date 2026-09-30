import { Controller, defineRequest, type ContextOf, type HttpContext } from '@bespokecore/http';
import * as v from 'valibot';
import type { AuthState, User } from '#modules/auth';
import { ProfileLinkRepository } from '../ProfileLinkRepository.ts';

export const AddProfileLinkRequest = defineRequest({
  schema: v.object({
    label: v.pipe(v.string(), v.trim(), v.minLength(1, 'Give the link a label.'), v.maxLength(60)),
    // http(s) only: a `javascript:` URL in an href would run in every visitor's browser.
    url: v.pipe(v.string(), v.trim(), v.url('Enter a full URL.'), v.regex(/^https?:\/\//i, 'Only http and https links.'), v.maxLength(2048)),
  }),
  authorize: (ctx: HttpContext<AuthState, { user: User }>) => ctx.user.id === ctx.params.user.id,
});

export class AddProfileLinkController extends Controller {
  static request = AddProfileLinkRequest;

  readonly #links: ProfileLinkRepository;

  constructor(links: ProfileLinkRepository) {
    super();
    this.#links = links;
  }

  async handle(ctx: ContextOf<typeof AddProfileLinkRequest>) {
    await this.#links.insert({ user_id: ctx.params.user.id, ...ctx.body });
    return this.redirect().route('user-profile.show', { user: ctx.params.user.id }).with('status', 'Link added.');
  }
}
