import { throttle } from '@marmeon/cache';
import { credentialPage, defineRoutes, describeAccess, everyone } from '@marmeon/http';
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
import { CreateOneTimeLinkLabController, ShowAnnouncementLabController, OpenOneTimeLinkLabController, UseOneTimeLinkLabController } from './controllers/OneTimeLinkLabController.ts';
import { ClaimInvitationLabController, ShowInvitationLabController, StoreInvitationLabController } from './controllers/InvitationLabController.ts';
import { CreateGuestLabController, EditGuestLabController, StoreGuestLabController, UpdateGuestLabController } from './controllers/GuestLabController.ts';
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
  // Two forms that share a component: the fields a guest's create and edit forms have in common (`FormPart`).
  lab.get('/guests/new', CreateGuestLabController);
  lab.post('/guests', StoreGuestLabController);
  lab.get('/guests/edit', EditGuestLabController);
  lab.put('/guests', UpdateGuestLabController);
  // A form whose fields are rows of the database: the survey's questions. The binder 404s a survey without any, and the form's
  // schema is built from the rows after the lab's gate said yes.
  lab.bind('survey', Surveys, { public: true }).get('/surveys/:survey', ShowSurveyLabController);
  lab.bind('survey', Surveys, { public: true }).post('/surveys/:survey', StoreSurveyLabController);
  // A link that is used once: its path is the token, found by its hash (`hashLinkToken()`). Open to everyone and public by design — the
  // token is the key, and every wrong token gets the same 404. The GET only shows a page; the POST uses the link up.
  // `credentialPage()` marks every answer of the routes that carry the token, errors and the 404 for a wrong token included.
  const link = group.middleware(credentialPage());
  link.authorize(everyone).middleware(throttle('lab.one-time-links')).post('/one-time-links', CreateOneTimeLinkLabController);
  link.authorize(everyone).bind('link', OneTimeLinkRepository, { public: true }).get('/one-time-links/:link', OpenOneTimeLinkLabController);
  // The POST changes data, so the link itself is the decision: the binder found an unused link by its token, and the update that
  // uses it up decides again.
  link
    .middleware(throttle('lab.one-time-links'))
    .bind('link', OneTimeLinkRepository)
    .authorize(describeAccess((ctx) => ctx.params.link !== undefined, 'one-time link'))
    .post('/one-time-links/:link', UseOneTimeLinkLabController);
  // A form behind a token: the token's route trades it for the link's id in the session and redirects to a page without it. That page
  // and its POST keep `same-origin`, so `back()` returns to the form after a failed validation.
  link.authorize(everyone).bind('link', OneTimeLinkRepository, { public: true }).get('/invitations/:link', ClaimInvitationLabController);
  // A public page that carries a token only sometimes: cacheable as it is, `no-store` and without a Referer once the address has `?invite=`.
  group.middleware(credentialPage({ query: ['invite'] })).authorize(everyone).get('/announcement', ShowAnnouncementLabController);
  const form = group.middleware(credentialPage({ referrer: 'same-origin' })).authorize(everyone);
  form.get('/invitation', ShowInvitationLabController);
  form.post('/invitation', StoreInvitationLabController);
});
