import { defineRoutes, everyone } from '@marmeon/http';
import { ShowAboutController } from './controllers/ShowAboutController.ts';
import { ShowFeatureController } from './controllers/ShowFeatureController.ts';

export default defineRoutes((Route) => {
  // Under /:locale — /en/about, /de/about: one URL per language, so the page speaks the language of its address. Decided for both
  // pages: they show the same fixed text to everyone and read nothing of the visitor. A route you add needs its own decision.
  const about = Route.localized().authorize(everyone).name('about.');
  // `sitemap()` lists a page in /sitemap.xml, in each language: this one by its path, the features by the entries of their controller.
  about.get('/about', ShowAboutController).name('index').sitemap();
  // Lower-case letters and dashes only: anything else is a 404 before the controller runs.
  about.get('/about/features/:feature{[a-z-]+}', ShowFeatureController).name('features.show').sitemap();
});
