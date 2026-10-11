import { defineModule } from '@marmeon/core';
import { SiteConfig } from '../../config/site.ts';
import { LegalServiceProvider } from './LegalServiceProvider.ts';
import { SiteServiceProvider } from './SiteServiceProvider.ts';

export default defineModule({
  name: 'site',
  config: [SiteConfig],
  // The routes come from the provider: they go into the `public` group (no cookies, no session), not `web`.
  providers: [SiteServiceProvider, LegalServiceProvider],
});
