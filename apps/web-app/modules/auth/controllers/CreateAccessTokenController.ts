import { AccessTokenStore, type Authenticated } from '@bespokecore/auth';
import { Controller, defineRequest, type ContextOf, type HttpContext } from '@bespokecore/http';
import { Session } from '@bespokecore/session';
import * as v from 'valibot';
import { TOKEN_ABILITIES, type TokenAbility } from '../abilities.ts';

const abilityNames = Object.keys(TOKEN_ABILITIES) as [TokenAbility, ...TokenAbility[]];

export const CreateAccessTokenRequest = defineRequest({
  schema: v.object({
    name: v.pipe(v.string('Name the token.'), v.trim(), v.minLength(1, 'Name the token.'), v.maxLength(60)),
    // One ability or several (an HTML form sends one value per checkbox).
    abilities: v.pipe(
      v.union([v.picklist(abilityNames), v.pipe(v.array(v.picklist(abilityNames)), v.minLength(1))], 'Pick what the token may do.'),
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
  readonly #session: Session;

  constructor(tokens: AccessTokenStore, session: Session) {
    super();
    this.#tokens = tokens;
    this.#session = session;
  }

  async handle(ctx: ContextOf<typeof CreateAccessTokenRequest>) {
    const { plainText } = await this.#tokens.create(ctx.user.id, ctx.body.name, { abilities: ctx.body.abilities, expiresIn: '90d' });
    return this.view('auth/AccessTokens', {
      tokens: await this.#tokens.list(ctx.user.id),
      abilities: TOKEN_ABILITIES,
      plainText: plainText as string | null,
      csrfToken: this.#session.token(),
    });
  }
}
