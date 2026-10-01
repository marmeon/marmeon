import { defineRoutes } from '@bespokecore/http';
import {
  ShowBrowserOnlyLabController,
  ShowClientOnlyLabController,
  ShowLateErrorLabController,
  ShowStreamingLabController,
} from './controllers/ShowLabPageController.ts';

// Unnamed on purpose: they are not part of the app (no route names in bootstrap/routes.ts, nothing in the browser's
// manifest) and answer 404 unless the lab is on.
export default defineRoutes((Route) => {
  const lab = Route.prefix('/lab');
  lab.get('/streaming', ShowStreamingLabController);
  lab.get('/client-only', ShowClientOnlyLabController);
  lab.get('/browser-only', ShowBrowserOnlyLabController);
  lab.get('/late-error', ShowLateErrorLabController);
});
