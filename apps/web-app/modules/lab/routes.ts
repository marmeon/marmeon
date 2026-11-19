import { authenticate, verified } from '@marmeon/auth';
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
import { LabOnly } from './LabOnly.ts';
import { LocalOidcHost } from './LocalOidcHost.ts';
import { OneTimeLinkRepository } from './OneTimeLinkRepository.ts';
import { AddQuestionLabController, ShowSurveyLabController, StoreSurveyLabController } from './controllers/SurveyLabController.ts';
import { Surveys } from './SurveyRepository.ts';
import { SendChatLabController, ShowChatLabController } from './controllers/ChatLabController.ts';
import { PingWebhookLabController, ShowWebhookPingLabController } from './controllers/WebhookPingLabController.ts';
import { ShowLocalOidcAuthorizeController, ShowLocalOidcConfigurationController, StoreLocalOidcAuthorizeController } from './controllers/LocalOidcController.ts';
import { RaceValidationLabController, ShowValidationLabController, StoreValidationLabController } from './controllers/ValidationLabController.ts';

// Unnamed on purpose: they are not part of the app (no route names in bootstrap/routes.ts, nothing in the browser's
// manifest). `LabOnly` is the first middleware of every `/lab` chain below (after `credentialPage()` where the path is a credential): a
// request answers 404 unless the lab is on before the route's own limit counts, its binder looks a record up or a guest is sent to sign in.
// The global and the web group's middleware run first. The routes of the local provider (`/_dev/oidc`) follow their own rule, below.
export default defineRoutes((Route) => {
  // Open to everyone, since the lab shows nothing of the app's records and the gate has answered 404 before unless the lab is on. A lab route
  // added later decides for itself, and takes one of the chains below: a chain built on `group` without `LabOnly` skips the gate.
  const group = Route.prefix('/lab');
  const lab = group.middleware(LabOnly).authorize(everyone);
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
  // A choice for the survey: its words are a JSON column typed `readonly string[]`, and the request's schema is what checks them.
  lab.bind('survey', Surveys, { public: true }).post('/surveys/:survey/questions', AddQuestionLabController);
  // A link that is used once: its path is the token, found by its hash (`hashLinkToken()`). Open to everyone and public by design — the
  // token is the key, and every wrong token gets the same 404. The GET only shows a page; the POST uses the link up.
  // `credentialPage()` marks every answer of the routes that carry the token, errors, the 404 for a wrong token and the
  // lab's 404 included: it runs before `LabOnly`.
  const link = group.middleware(credentialPage()).middleware(LabOnly);
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
  group.middleware(credentialPage({ query: ['invite'] })).middleware(LabOnly).authorize(everyone).get('/announcement', ShowAnnouncementLabController);
  const form = group.middleware(credentialPage({ referrer: 'same-origin' })).middleware(LabOnly).authorize(everyone);
  form.get('/invitation', ShowInvitationLabController);
  form.post('/invitation', StoreInvitationLabController);
  // An address an editor entered, called by the server: `HttpClient` refuses what is not public when it sends.
  lab.get('/webhook-ping', ShowWebhookPingLabController);
  lab.middleware(throttle('lab.webhook-ping')).post('/webhook-ping', PingWebhookLabController);
  // A chat notification: a signed-in user sends a message that the `chat` channel posts to the `ops` destination of `CHAT_WEBHOOKS`.
  // `lab` has answered 404 first: when the lab is off, no guest is sent to sign in and the route's limit does not count. A confirmed address, as the other modules ask for.
  const chat = lab.middleware(authenticate()).middleware(verified());
  chat.get('/chat', ShowChatLabController);
  chat.middleware(throttle('lab.chat')).post('/chat', SendChatLabController);

  // The local OpenID Connect provider (`OAUTH_LOCAL_*`), whatever the lab says. `LocalOidcHost` answers only the app's own hosts (403 for another,
  // so a rebound DNS name cannot use it) and `LocalOidc.provider()` is a 404 outside development and test; in production the form post is
  // refused by the CSRF check first (419, or 403 from another site). Open to everyone: a sign-in starts here before anybody is signed in.
  // Its token endpoint is in api-routes.ts.
  const oidcRoutes = Route.prefix('/_dev/oidc').middleware(LocalOidcHost).authorize(everyone);
  oidcRoutes.get('/.well-known/openid-configuration', ShowLocalOidcConfigurationController);
  oidcRoutes.get('/authorize', ShowLocalOidcAuthorizeController);
  oidcRoutes.post('/authorize', StoreLocalOidcAuthorizeController);
});
