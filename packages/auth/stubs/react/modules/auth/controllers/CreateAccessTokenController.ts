import { AccessTokenStore, type Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, type ContextOf } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { abilityDescriptions, TOKEN_ABILITIES, type TokenAbility } from '../abilities.ts';

const abilityNames = [...TOKEN_ABILITIES] as [TokenAbility, ...TokenAbility[]];

export const CreateAccessTokenRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().max(60),
    // One ability or several (an HTML form sends one value per checkbox) — and none at all when no box is ticked: a form
    // leaves unchecked boxes out (`<Form>`, or no JavaScript), so a missing key is "none", with the same message.
    abilities: r.union([r.in(abilityNames), r.array(r.in(abilityNames)).required()]).transform((value) => [value].flat()),
  }),
  messages: {
    'name.required': 'auth.validation.token_name',
    'abilities.required': 'auth.validation.token_abilities',
    'abilities.union': 'auth.validation.token_abilities',
    'abilities.*.in': 'auth.validation.token_abilities',
  },
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

  async handle(ctx: ContextOf<typeof CreateAccessTokenRequest> & Authenticated) {
    const { plainText } = await this.#tokens.create(ctx.user.id, ctx.body.name, { abilities: ctx.body.abilities, expiresIn: '90d' });
    return this.view('auth/AccessTokens', {
      tokens: await this.#tokens.list(ctx.user.id),
      abilities: abilityDescriptions(this.#translator),
      plainText: plainText as string | null,
    });
  }
}
