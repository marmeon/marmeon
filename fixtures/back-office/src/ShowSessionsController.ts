import { Controller } from '@marmeon/http';
import { OfficeAuth } from './guard.ts';

/** The editor's own sign-ins, the current browser first. Never the raw user agent and no address: only the parts the page words. */
export class ShowSessionsController extends Controller {
  static readonly inject = [OfficeAuth] as const;

  readonly #auth: OfficeAuth;

  constructor(auth: OfficeAuth) {
    super();
    this.#auth = auth;
  }

  async handle() {
    const signIns = (await this.#auth.signIns()).map((signIn) => ({
      id: signIn.id,
      current: signIn.current,
      lastSeenAt: signIn.lastSeenAt.toISOString(),
      device: { browser: signIn.device.browser ?? null, system: signIn.device.system ?? null },
    }));
    return this.view('office::Sessions', { signIns });
  }
}
