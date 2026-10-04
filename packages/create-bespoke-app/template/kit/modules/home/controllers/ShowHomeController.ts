import { Controller } from '@bespokecore/http';
import { AppConfig } from '../../../config/app.ts';

/** `/` for everyone: guests see the way in, signed-in people the way to their dashboard (the layout knows who is signed in). */
export class ShowHomeController extends Controller {
  readonly #config: AppConfig;

  constructor(config: AppConfig) {
    super();
    this.#config = config;
  }

  handle() {
    return this.view('home/Home', { appName: this.#config.name });
  }
}
