import { Controller } from '@marmeon/http';
import { OAuth } from '@marmeon/oauth';

/** The sign-in buttons: one per provider that is active. An island, placed on your sign-in page. */
export class ShowSignInButtonsController extends Controller {
  readonly #oauth: OAuth;

  constructor(oauth: OAuth) {
    super();
    this.#oauth = oauth;
  }

  handle() {
    // The name goes into the form's address, the label is the text. Nothing else about a provider reaches the browser.
    return this.island('oauth/SignInButtons', { providers: this.#oauth.providers().map(({ name, label }) => ({ name, label })) });
  }
}
