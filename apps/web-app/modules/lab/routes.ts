import { throttle } from '@marmeon/cache';
import { defineRoutes, describeAccess, everyone } from '@marmeon/http';
import {
  ShowBrowserOnlyLabController,
  ShowClientOnlyLabController,
  ShowLateErrorLabController,
  ShowRenderErrorLabController,
  ShowErrorsLabController,
  ShowStreamingLabController,
  TriggerErrorLabController,
} from './controllers/ShowLabPageController.ts';
import { SendDevtoolsLabController, ShowDevtoolsLabController } from './controllers/ShowDevtoolsLabController.ts';
import { CreateOneTimeLinkLabController, OpenOneTimeLinkLabController, UseOneTimeLinkLabController } from './controllers/OneTimeLinkLabController.ts';
import { OneTimeLinkRepository } from './OneTimeLinkRepository.ts';
import { ShowSurveyLabController, StoreSurveyLabController } from './controllers/SurveyLabController.ts';
import { Surveys } from './SurveyRepository.ts';
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
  // A page that throws in the browser, inside a layout with `error` and a retry.
  lab.get('/render-error', ShowRenderErrorLabController);
  // Errors on purpose, one per kind — the development error page with its solutions.
  lab.get('/errors', ShowErrorsLabController);
  lab.get('/errors/:kind', TriggerErrorLabController);
  // The devtools' bar: the client hook API, and a hydration mismatch on purpose (`?mismatch=1`).
  lab.get('/devtools', ShowDevtoolsLabController);
  lab.middleware(throttle('lab.devtools')).post('/devtools', SendDevtoolsLabController);
  // The rules of @marmeon/validation: messages in the request's language, a taken address on submit only —
  // and the same form without `unique`, where the unique index answers (`failOnDuplicate`, as after a race).
  lab.get('/validation', ShowValidationLabController);
  lab.post('/validation', StoreValidationLabController);
  lab.post('/validation/race', RaceValidationLabController);
  // A form whose fields are rows of the database: the survey's questions. The binder 404s a survey without any, and the form's
  // schema is built from the rows after the lab's gate said yes.
  lab.bind('survey', Surveys, { public: true }).get('/surveys/:survey', ShowSurveyLabController);
  lab.bind('survey', Surveys, { public: true }).post('/surveys/:survey', StoreSurveyLabController);
  // A link that is used once: its path is the token, found by its hash (`hashLinkToken()`). Open to everyone and public by design — the
  // token is the key, and every wrong token gets the same 404. The GET only shows a page; the POST uses the link up.
  lab.middleware(throttle('lab.one-time-links')).post('/one-time-links', CreateOneTimeLinkLabController);
  lab.bind('link', OneTimeLinkRepository, { public: true }).get('/one-time-links/:link', OpenOneTimeLinkLabController);
  // The POST changes data, so the link itself is the decision: the binder found an unused link by its token, and the update that
  // uses it up decides again.
  const holdsLink = describeAccess((ctx) => ctx.params.link !== undefined, 'one-time link');
  group.authorize(holdsLink).middleware(throttle('lab.one-time-links')).bind('link', OneTimeLinkRepository).post('/one-time-links/:link', UseOneTimeLinkLabController);
});
