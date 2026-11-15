import { Gate } from '@marmeon/auth';
import { Controller, type HttpContext } from '@marmeon/http';
import { BackOfficeConfig } from './BackOfficeConfig.ts';
import { OfficePolicy } from './OfficePolicy.ts';
import type { EditorUser } from './OfficeUser.ts';

/** The back office's first page: who is signed in, and what they may do. */
export class ShowOverviewController extends Controller {
  static readonly inject = [Gate, BackOfficeConfig] as const;

  readonly #gate: Gate;
  readonly #config: BackOfficeConfig;

  constructor(gate: Gate, config: BackOfficeConfig) {
    super();
    this.#gate = gate;
    this.#config = config;
  }

  async handle(ctx: HttpContext<{ readonly user: EditorUser }>) {
    return this.view('office::Overview', {
      name: ctx.user.name,
      users: this.#config.users,
      // A capability prop: the page offers publishing to editors only, and the policy decides again where publishing happens.
      canPublish: await this.#gate.allows(OfficePolicy, 'publish'),
    });
  }
}
