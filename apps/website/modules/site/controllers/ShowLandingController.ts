import { Controller } from '@marmeon/http';
import { MODULE_FILES } from '../module-files.ts';
import { PACKAGE_GROUPS, PACKAGES } from '../packages.ts';
import { SiteSnippets } from '../SiteSnippets.ts';
import { SiteStack } from '../stack.ts';

/** `/`: the landing page, with its code already highlighted and the list of packages (`packages`, grouped by `packageGroups`), the notes module's files and the hero's stack of layers (`stack`, links already checked against the docs and the packages; the page stays publicly cacheable). All stay on the server: the client bundle only gets them as props. */
export class ShowLandingController extends Controller {
  readonly #snippets: SiteSnippets;

  readonly #stack: SiteStack;

  constructor(snippets: SiteSnippets, stack: SiteStack) {
    super();
    this.#snippets = snippets;
    this.#stack = stack;
  }

  handle() {
    return this.view('site/Landing', { snippets: this.#snippets.all(), chain: this.#snippets.chain(), packages: PACKAGES, packageGroups: PACKAGE_GROUPS, moduleFiles: MODULE_FILES, stack: this.#stack.stack });
  }
}
