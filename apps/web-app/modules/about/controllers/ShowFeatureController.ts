import { abort, Controller, type HttpContext, type SitemapEntries } from '@marmeon/http';
import { FeatureCatalog } from '../FeatureCatalog.ts';

/** `/about/features/:feature`: one feature — a 404 for a slug the catalog does not know. */
export class ShowFeatureController extends Controller {
  readonly #catalog: FeatureCatalog;

  constructor(catalog: FeatureCatalog) {
    super();
    this.#catalog = catalog;
  }

  handle(ctx: HttpContext<{}, { feature: string }>) {
    return this.view('about/Feature', { feature: this.#catalog.find(ctx.params.feature) ?? abort(404) });
  }

  /** The pages of this route in /sitemap.xml: one per feature, with the day it changed. */
  sitemap(): SitemapEntries<{ feature: string }> {
    return this.#catalog.all().map((feature) => ({ params: { feature: feature.slug }, lastModified: new Date(feature.updatedAt) }));
  }
}
