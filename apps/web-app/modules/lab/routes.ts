import { defineRoutes, everyone } from '@marmeon/http';
import {
  ShowBrowserOnlyLabController,
  ShowClientOnlyLabController,
  ShowLateErrorLabController,
  ShowErrorsLabController,
  ShowStreamingLabController,
  TriggerErrorLabController,
} from './controllers/ShowLabPageController.ts';
import { SendDevtoolsLabController, ShowDevtoolsLabController } from './controllers/ShowDevtoolsLabController.ts';
import { RaceValidationLabController, ShowValidationLabController, StoreValidationLabController } from './controllers/ValidationLabController.ts';

// Unnamed on purpose: they are not part of the app (no route names in bootstrap/routes.ts, nothing in the browser's
// manifest) and answer 404 unless the lab is on.
export default defineRoutes((Route) => {
  // Open to everyone, since the lab shows nothing of the app's records: the pages answer 404 unless the lab is on. A lab route added
  // later decides for itself.
  const group = Route.prefix('/lab');
  const lab = group.authorize(everyone);
  lab.get('/streaming', ShowStreamingLabController);
  lab.get('/client-only', ShowClientOnlyLabController);
  lab.get('/browser-only', ShowBrowserOnlyLabController);
  lab.get('/late-error', ShowLateErrorLabController);
  // Errors on purpose, one per kind — the development error page with its solutions.
  lab.get('/errors', ShowErrorsLabController);
  lab.get('/errors/:kind', TriggerErrorLabController);
  // The devtools' bar: the client hook API, and a hydration mismatch on purpose (`?mismatch=1`).
  lab.get('/devtools', ShowDevtoolsLabController);
  lab.post('/devtools', SendDevtoolsLabController);
  // The rules of @marmeon/validation: messages in the request's language, a taken address on submit only —
  // and the same form without `unique`, where the unique index answers (`failOnDuplicate`, as after a race).
  lab.get('/validation', ShowValidationLabController);
  lab.post('/validation', StoreValidationLabController);
  lab.post('/validation/race', RaceValidationLabController);
});
