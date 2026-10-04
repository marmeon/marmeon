import { defineModule } from '@bespokecore/core';
import { DocsConfig } from '../../config/docs.ts';
import { DocsServiceProvider } from './DocsServiceProvider.ts';

export default defineModule({
  name: 'docs',
  config: [DocsConfig],
  // The routes come from the provider: they go into the `docs` group (no cookies, no session), not `web`.
  providers: [DocsServiceProvider],
});
