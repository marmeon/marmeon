import { defineModule } from '@marmeon/core';
import { LocaleServiceProvider } from './LocaleServiceProvider.ts';
import routes from './routes.ts';

/** The language switcher (`POST /locale`) and the talk pages in the language of their talk — texts in the app-wide `lang/` (namespace `app`). */
export default defineModule({
  name: 'locale',
  providers: [LocaleServiceProvider],
  routes,
});
