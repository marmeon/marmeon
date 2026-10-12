import { Controller } from '@marmeon/http';
import { AppConfig } from '../../../config/app.ts';
import { DocsRepository } from '../../docs/DocsRepository.ts';
import { publicUrl } from '../public-url.ts';
import { sitemapPaths, sitemapXml } from '../seo.ts';
import { textResponse } from '../text-response.ts';

/** `/sitemap.xml`: every public page, as absolute URLs from `APP_URL`. */
export class ShowSitemapController extends Controller {
  readonly #docs: DocsRepository;
  readonly #app: AppConfig;

  constructor(docs: DocsRepository, app: AppConfig) {
    super();
    this.#docs = docs;
    this.#app = app;
  }

  handle() {
    return textResponse(sitemapXml(sitemapPaths(this.#docs.pages()).map((path) => publicUrl(this.#app, path))), 'application/xml; charset=utf-8');
  }
}
