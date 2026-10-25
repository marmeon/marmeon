import { AccessTokenStore, Auth, type Authenticated } from '@marmeon/auth';
import { Controller, defineRequest, ValidationError, type ContextOf, type HttpContext } from '@marmeon/http';
import { Translator } from '@marmeon/i18n';
import { rules as r } from '@marmeon/validation';
import { abilityDescriptions, TOKEN_ABILITIES, type TokenAbility } from '../abilities.ts';
import { passwordCheckMessage } from '../password-errors.ts';

const abilityNames = [...TOKEN_ABILITIES] as [TokenAbility, ...TokenAbility[]];

export const CreateAccessTokenRequest = defineRequest({
  schema: r.object({
    name: r.string().trim().required().max(60),
    // Typed now, whatever confirmed sudo mode: a token outlives the session and a password change, so a stolen session must not be able to mint one.
    current_password: r.string().required().max(4096),
    // One ability or several (an HTML form sends one value per checkbox) — and none at all when no box is ticked: a form
    // leaves unchecked boxes out (`<Form>`, or no JavaScript), so a missing key is "none", with the same message.
    abilities: r.union([r.in(abilityNames), r.array(r.in(abilityNames)).required()]).transform((value) => [value].flat()),
  }),
  messages: {
    'name.required': 'auth.validation.token_name',
    'current_password.required': 'auth.validation.current_password_required',
    'abilities.required': 'auth.validation.token_abilities',
    'abilities.union': 'auth.validation.token_abilities',
    'abilities.*.in': 'auth.validation.token_abilities',
  },
});

/** The two steps of creating a token share one layer: the answer replaces the form in place. */
const LAYER = { base: 'auth.tokens', key: 'tokens.create' } as const;

/** The form for a new token — a layer over the list (`<Link route="auth.tokens.create" layer>`). */
export class ShowCreateAccessTokenController extends Controller {
  readonly #translator: Translator;

  constructor(translator: Translator) {
    super();
    this.#translator = translator;
  }

  handle(_ctx: HttpContext<Authenticated>) {
    return this.view('auth/CreateAccessToken', { abilities: abilityDescriptions(this.#translator) }).layer(LAYER);
  }
}

/**
 * A new token. Its plain text is in this one response — rendered, not redirected, so it never sits in the session (a
 * flash would store it); the database keeps only its hash. It is a layer answered by a POST, so it is shown once:
 * it replaces the form, and when it closes — the button, Escape, Back — it is gone from the tab's memory too (Forward asks
 * the server, whose GET is the list), and the list beneath reloads with the new token in it.
 */
export class CreateAccessTokenController extends Controller {
  static request = CreateAccessTokenRequest;

  readonly #tokens: AccessTokenStore;
  readonly #auth: Auth;
  readonly #translator: Translator;

  constructor(tokens: AccessTokenStore, auth: Auth, translator: Translator) {
    super();
    this.#tokens = tokens;
    this.#auth = auth;
    this.#translator = translator;
  }

  async handle(ctx: ContextOf<typeof CreateAccessTokenRequest> & Authenticated) {
    const checked = await this.#auth.checkPassword(ctx.body.current_password);
    if (!checked.ok) throw new ValidationError({ current_password: [passwordCheckMessage(this.#translator, checked.error)] });
    const { plainText } = await this.#tokens.create(ctx.user.id, ctx.body.name, { abilities: ctx.body.abilities, expiresIn: { days: 90 } });
    return this.view('auth/NewAccessToken', { name: ctx.body.name, plainText: plainText as string }).layer(LAYER);
  }
}
