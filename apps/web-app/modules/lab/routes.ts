import { defineRoutes } from '@bespokecore/http';
import {
  ShowBrowserOnlyLabController,
  ShowClientOnlyLabController,
  ShowLateErrorLabController,
  ShowErrorsLabController,
  ShowStreamingLabController,
  TriggerErrorLabController,
} from './controllers/ShowLabPageController.ts';

// Unnamed on purpose: they are not part of the app (no route names in bootstrap/routes.ts, nothing in the browser's
// manifest) and answer 404 unless the lab is on.
export default defineRoutes((Route) => {
  const lab = Route.prefix('/lab');
  lab.get('/streaming', ShowStreamingLabController);
  lab.get('/client-only', ShowClientOnlyLabController);
  lab.get('/browser-only', ShowBrowserOnlyLabController);
  lab.get('/late-error', ShowLateErrorLabController);
  // Errors on purpose, one per kind — the development error page with its solutions (E119, E130).
  lab.get('/errors', ShowErrorsLabController);
  lab.get('/errors/:kind', TriggerErrorLabController);
});
