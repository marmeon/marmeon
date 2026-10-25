import { defineRoutes, everyone } from '@marmeon/http';
import { ShowAboutController } from './controllers/ShowAboutController.ts';
import { ShowFeatureController } from './controllers/ShowFeatureController.ts';

export default defineRoutes((Route) => {
  // Decided for both pages: they show the same fixed text to everyone and read nothing of the visitor. A route you add needs its own decision.
  const about = Route.authorize(everyone).name('about.');
  about.get('/about', ShowAboutController).name('index');
  // Lower-case letters and dashes only: anything else is a 404 before the controller runs.
  about.get('/about/features/:feature{[a-z-]+}', ShowFeatureController).name('features.show');
});
