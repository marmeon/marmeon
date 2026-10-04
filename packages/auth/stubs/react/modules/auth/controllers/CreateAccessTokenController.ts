import { AccessTokenStore, type Authenticated } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf, type HttpContext } from '@bespokecore/http';
import { trans, Translator } from '@bespokecore/i18n';
import * as v from 'valibot';
import { abilityDescriptions, TOKEN_ABILITIES, type TokenAbility } from '../abilities.ts';

const abilityNames = [...TOKEN_ABILITIES] as [TokenAbility, ...TokenAbility[]];

export const CreateAccessTokenRequest = defineRequest({
  schema: v.object({
    name: v.pipe(v.string(trans('auth.validation.token_name')), v.trim(), v.minLength(1, trans('auth.validation.token_name')), v.maxLength(60)),
    // One ability or several (an HTML form sends one value per checkbox).
    abilities: v.pipe(
      v.union([v.picklist(abilityNames), v.pipe(v.array(v.picklist(abilityNames)), v.minLength(1))], trans('auth.validation.token_abilities')),
      v.transform((value) => [value].flat()),
    ),
  }),
  authorize: (_ctx: HttpContext<Authenticated>) => true,
});

/**
 * A new token. Its plain text is in this one response — rendered, not redirected, so it never sits in
 * the session (a flash would store it). The database keeps only its hash.
 */
export class CreateAccessTokenController extends Controller {
  static request = CreateAccessTokenRequest;

  readonly #tokens: AccessTokenStore;
  readonly #translator: Translator;

  constructor(tokens: AccessTokenStore, translator: Translator) {
    super();
    this.#tokens = tokens;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof CreateAccessTokenRequest>) {
    const { plainText } = await this.#tokens.create(ctx.user.id, ctx.body.name, { abilities: ctx.body.abilities, expiresIn: '90d' });
    return this.view('auth/AccessTokens', {
      tokens: await this.#tokens.list(ctx.user.id),
      abilities: abilityDescriptions(this.#translator),
      plainText: plainText as string | null,
    });
  }
}
