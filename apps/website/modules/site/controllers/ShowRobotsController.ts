import { Controller } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { publicUrl } from '../public-url.ts';
import { robotsTxt } from '../seo.ts';
import { textResponse } from '../text-response.ts';

/** `/robots.txt`: the same in every environment. */
export class ShowRobotsController extends Controller {
  readonly #app: AppConfig;

  constructor(app: AppConfig) {
    super();
    this.#app = app;
  }

  handle() {
    return textResponse(robotsTxt(publicUrl(this.#app, '/sitemap.xml')), 'text/plain; charset=utf-8');
  }
}
