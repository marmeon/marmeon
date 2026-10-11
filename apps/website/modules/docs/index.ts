import { defineModule } from '@marmeon/core';
import { DocsConfig } from '../../config/docs.ts';
import { DocsServiceProvider } from './DocsServiceProvider.ts';

export default defineModule({
  name: 'docs',
  config: [DocsConfig],
  // The routes come from the provider: they go into the `public` group (no cookies, no session), not `web`.
  providers: [DocsServiceProvider],
});
