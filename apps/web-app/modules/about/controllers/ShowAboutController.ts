import { Controller } from '@marmeon/http';
import { FeatureCatalog } from '../FeatureCatalog.ts';

/** `/about`: the list of features. */
export class ShowAboutController extends Controller {
  readonly #catalog: FeatureCatalog;

  constructor(catalog: FeatureCatalog) {
    super();
    this.#catalog = catalog;
  }

  handle() {
    return this.view('about/Index', { features: this.#catalog.all().map(({ slug }) => ({ slug })) });
  }
}
